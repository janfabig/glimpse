// Gemini implementation of the Analyzer contract (docs/ARCHITECTURE.md §7).
import type { File as GeminiFile, Model } from '@google/genai'
import type { ApiKeyTestResult, ModelOption, RemoteFileRef } from '@shared/types'
import type { AnalyzeRequest, AnalyzeResponse, AnalyzeStage, Analyzer } from '../contracts'
import {
  createClientCache,
  createGenAiClient,
  DEFAULT_BASE_URL,
  keyId,
  type GenAiClient
} from './client'
import { classifyError, throwIfCancelled, toAnalyzerError } from './errors'
import {
  deleteQuietly,
  findReusableFile,
  toRemoteFileRef,
  UploadMemory,
  uploadProxy,
  UploadSessions,
  waitUntilActive,
  type ActiveFile,
  type FileDeps
} from './files'
import { generateMoments } from './generate'
import { consoleLogger, type AnalyzerLogger } from './logger'
import { MESSAGES } from './messages'
import { buildModelOptions, DEFAULT_MODEL } from './models'
import { sleep, withRetries } from './retry'
import { UPLOAD_CHUNK_SIZE } from './upload'

export interface GeminiDeps extends FileDeps {
  /** SDK client factory (one client per API key is cached) */
  createClient: (apiKey: string) => GenAiClient
  /** IANA zone for recording times in the prompt; default: system zone */
  timeZone?: string
}

const LIST_TIMEOUT_MS = 30_000
/** a model list longer than this means a paging bug, not more models */
const MAX_LISTED_MODELS = 1_000

export function defaultGeminiDeps(): GeminiDeps {
  return {
    createClient: createGenAiClient,
    fetch: (url, init) => fetch(url, init),
    sleep,
    now: () => Date.now(),
    random: () => Math.random(),
    logger: consoleLogger,
    uploadBaseUrl: DEFAULT_BASE_URL,
    chunkSize: UPLOAD_CHUNK_SIZE,
    pollIntervalMs: 2_000,
    processingTimeoutMs: 10 * 60_000
  }
}

export function createGeminiAnalyzer(overrides: Partial<GeminiDeps> = {}): Analyzer {
  // an explicit `undefined` (e.g. an optional logger that is not set) keeps the default
  const defined = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined)
  ) as Partial<GeminiDeps>
  const deps: GeminiDeps = { ...defaultGeminiDeps(), ...defined }
  const clientFor = createClientCache(deps.createClient)
  const kept = new UploadMemory()
  const interrupted = new UploadSessions()

  /** Reused or freshly uploaded and ACTIVE; reported via onRemoteFile before generation starts. */
  async function obtainFile(
    client: GenAiClient,
    req: AnalyzeRequest,
    apiKey: string,
    stage: StageFn,
    background: Background
  ): Promise<ActiveFile> {
    const fingerprint = req.video.proxyFingerprint
    const id = keyId(apiKey)
    const report = guardRemoteFile(req.onRemoteFile, deps.logger)
    stage('uploading', 0)
    const reusable = await findReusableFile(
      client,
      [req.remoteFile, kept.get(id, fingerprint)],
      fingerprint,
      deps,
      req.signal
    )
    if (reusable) {
      deps.logger.info('reusing the uploaded proxy', { name: reusable.name })
      report(toRemoteFileRef(reusable, fingerprint))
      return reusable
    }
    const session = interrupted.take(id, fingerprint)
    let uploaded: GeminiFile
    try {
      uploaded = await uploadProxy(
        client,
        {
          apiKey,
          path: req.video.proxyPath,
          displayName: req.video.fileName,
          signal: req.signal,
          onProgress: (fraction) => stage('uploading', fraction),
          onCleanup: background,
          session
        },
        deps
      )
    } catch (err) {
      // the network stayed away: trying again continues this upload (not after a cancel – the
      // user may not want the video uploaded at all)
      if (!req.signal?.aborted) interrupted.keep(id, fingerprint, session)
      throw err
    }
    stage('processing', -1)
    let active: ActiveFile
    try {
      active = await waitUntilActive(client, uploaded, deps, req.signal)
    } catch (err) {
      // FAILED, timed out or cancelled: nobody will use this upload again. Core was never told
      // about it (that happens at ACTIVE), so it learns about the delete instead – quitting the
      // app while Gemini processes the video waits for it.
      if (uploaded.name) background(discard(client, uploaded.name))
      throw err
    }
    const ref = toRemoteFileRef(active, fingerprint)
    kept.remember(id, ref)
    report(ref)
    return active
  }

  async function discard(client: GenAiClient, name: string): Promise<void> {
    kept.forget(name)
    await deleteQuietly(client, name, deps.logger)
  }

  async function analyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
    const apiKey = req.apiKey.trim()
    const model = req.model.trim() || DEFAULT_MODEL
    const client = clientFor(apiKey)
    const stage = guardStage(req.onStage, deps.logger)
    const background = guardCleanup(req.onCleanup, deps.logger)
    let file: ActiveFile | null = null
    try {
      throwIfCancelled(req.signal)
      file = await obtainFile(client, req, apiKey, stage, background)
      stage('analyzing', -1)
      const { report, usage } = await generateMoments(
        client,
        {
          model,
          file,
          video: req.video,
          brief: req.brief,
          earlierClips: req.earlierClips,
          signal: req.signal
        },
        deps
      )
      const remoteFile = toRemoteFileRef(file, req.video.proxyFingerprint)
      return { moments: report.moments, model, usage, remoteFile }
    } catch (err) {
      if (file && classifyError(err).kind === 'file') {
        // expired or deleted meanwhile: the next attempt must upload again instead of reusing it
        kept.forget(file.name)
      }
      throw toAnalyzerError(err, { signal: req.signal, model })
    }
  }

  async function listModels(apiKey: string): Promise<ModelOption[]> {
    const client = clientFor(apiKey.trim())
    try {
      const models = await withRetries(() => fetchModels(client), {
        sleep: deps.sleep,
        random: deps.random,
        maxAttempts: 2
      })
      return buildModelOptions(models)
    } catch (err) {
      throw toAnalyzerError(err)
    }
  }

  async function testKey(apiKey: string): Promise<ApiKeyTestResult> {
    if (!apiKey.trim()) return { ok: false, message: MESSAGES.emptyKey }
    try {
      const models = await listModels(apiKey)
      return { ok: true, message: MESSAGES.keyOk(models.length), models }
    } catch (err) {
      const error = toAnalyzerError(err)
      // the key being tested is not stored yet: the way out is AI Studio, not the settings
      return error.code === 'auth'
        ? { ok: false, message: MESSAGES.keyRejected, rejected: true }
        : { ok: false, message: error.message }
    }
  }

  async function deleteRemoteFile(apiKey: string, name: string): Promise<void> {
    await discard(clientFor(apiKey.trim()), name)
  }

  return { analyze, listModels, testKey, deleteRemoteFile }
}

async function fetchModels(client: GenAiClient): Promise<Model[]> {
  const pager = await client.models.list({
    config: { pageSize: 100, httpOptions: { timeout: LIST_TIMEOUT_MS } }
  })
  const models: Model[] = []
  for await (const model of pager) {
    models.push(model)
    if (models.length >= MAX_LISTED_MODELS) break
  }
  return models
}

/** A throwing onRemoteFile callback must not break the analysis. */
function guardRemoteFile(
  onRemoteFile: AnalyzeRequest['onRemoteFile'],
  logger: AnalyzerLogger
): (ref: RemoteFileRef) => void {
  return (ref) => {
    try {
      onRemoteFile(ref)
    } catch (err) {
      logger.warn('onRemoteFile callback threw', { name: ref.name, detail: String(err) })
    }
  }
}

/** Hands background cleanup to the caller (AnalyzeRequest.onCleanup); it runs either way. */
type Background = (cleanup: Promise<void>) => void

function guardCleanup(onCleanup: AnalyzeRequest['onCleanup'], logger: AnalyzerLogger): Background {
  return (cleanup) => {
    // never rejects for the caller, and a failure is logged where it happens
    const settled = cleanup.catch((err: unknown) =>
      logger.warn('background cleanup failed', { detail: String(err) })
    )
    try {
      onCleanup?.(settled)
    } catch (err) {
      logger.warn('onCleanup callback threw', { detail: String(err) })
    }
  }
}

type StageFn = (stage: AnalyzeStage, progress: number) => void

/** Drops repeated identical events; a throwing progress callback must not break the analysis. */
function guardStage(onStage: AnalyzeRequest['onStage'], logger: AnalyzerLogger): StageFn {
  let last = ''
  return (stage, progress) => {
    const key = `${stage}:${progress}`
    if (key === last) return
    last = key
    try {
      onStage(stage, progress)
    } catch (err) {
      logger.warn('onStage callback threw', { stage, detail: String(err) })
    }
  }
}
