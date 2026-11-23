// Lifecycle of the uploaded proxy on Gemini's Files API: reuse, upload, wait for ACTIVE, delete.
import { openAsBlob } from 'node:fs'
import { FileState, type File as GeminiFile } from '@google/genai'
import type { RemoteFileRef } from '@shared/types'
import { AnalyzerError, isGeminiFileName } from '../contracts'
import type { GenAiClient } from './client'
import { classifyError, fileGoneError, isFileNotFound, isRetryable } from './errors'
import type { AnalyzerLogger } from './logger'
import { MESSAGES } from './messages'
import { untilAborted, withCallSignal, withRetries, type Sleep } from './retry'
import { UploadProtocolError, uploadResumable, type FetchLike, type UploadSession } from './upload'

/** the 720p H.264 proxy is what gets uploaded */
export const PROXY_MIME_TYPE = 'video/mp4'
/** a kept file must stay available at least this long to be reused */
export const REUSE_MIN_REMAINING_MS = 15 * 60_000
const FILE_REQUEST_TIMEOUT_MS = 30_000
const DELETE_TIMEOUT_MS = 15_000

export interface ActiveFile {
  name: string
  uri: string
  mimeType: string
  expiresAt: string | null
}

export interface FileDeps {
  fetch: FetchLike
  sleep: Sleep
  now: () => number
  random: () => number
  logger: AnalyzerLogger
  uploadBaseUrl: string
  chunkSize: number
  pollIntervalMs: number
  processingTimeoutMs: number
}

export function toRemoteFileRef(file: ActiveFile, proxyFingerprint: string): RemoteFileRef {
  return {
    name: file.name,
    uri: file.uri,
    mimeType: file.mimeType,
    expiresAt: file.expiresAt,
    proxyFingerprint
  }
}

/** Kept uploads per API key, so a retry after a failed analysis can skip the upload. */
export class UploadMemory {
  private readonly refs = new Map<string, RemoteFileRef>()

  get(keyId: string, fingerprint: string): RemoteFileRef | null {
    return this.refs.get(`${keyId}:${fingerprint}`) ?? null
  }

  remember(keyId: string, ref: RemoteFileRef): void {
    this.refs.set(`${keyId}:${ref.proxyFingerprint}`, ref)
  }

  forget(name: string): void {
    for (const [key, ref] of this.refs) if (ref.name === name) this.refs.delete(key)
  }
}

/**
 * Upload sessions that were interrupted (the network stayed away), per API key and proxy, so trying
 * the analysis again continues the upload instead of sending the whole proxy once more.
 */
export class UploadSessions {
  private readonly sessions = new Map<string, UploadSession>()

  /** the interrupted session of this proxy (it leaves the memory), else a new one */
  take(keyId: string, fingerprint: string): UploadSession {
    const key = `${keyId}:${fingerprint}`
    const session = this.sessions.get(key) ?? { url: null }
    this.sessions.delete(key)
    return session
  }

  /** keeps a started session for the next attempt (a session without URL is not worth keeping) */
  keep(keyId: string, fingerprint: string, session: UploadSession): void {
    if (session.url) this.sessions.set(`${keyId}:${fingerprint}`, session)
  }
}

function expiresTooSoon(expiresAt: string | null | undefined, now: number): boolean {
  if (!expiresAt) return false
  const time = Date.parse(expiresAt)
  return Number.isFinite(time) && time - now < REUSE_MIN_REMAINING_MS
}

/**
 * First reference that belongs to this proxy (fingerprint), lives long enough and is still ACTIVE
 * on Google's side. Errors only mean "not reusable" – the caller uploads instead.
 */
export async function findReusableFile(
  client: GenAiClient,
  refs: readonly (RemoteFileRef | null | undefined)[],
  fingerprint: string,
  deps: FileDeps,
  signal?: AbortSignal
): Promise<ActiveFile | null> {
  const checked = new Set<string>()
  for (const ref of refs) {
    if (!ref || ref.proxyFingerprint !== fingerprint || checked.has(ref.name)) continue
    if (!isGeminiFileName(ref.name)) continue
    checked.add(ref.name)
    if (expiresTooSoon(ref.expiresAt, deps.now())) continue
    let file: GeminiFile
    try {
      file = await withRetries(() => getFile(client, ref.name, signal), {
        sleep: deps.sleep,
        random: deps.random,
        signal,
        maxAttempts: 2
      })
    } catch (err) {
      const failure = classifyError(err, signal)
      if (failure.kind === 'cancelled') throw err
      deps.logger.info('kept remote file is not reusable', {
        name: ref.name,
        detail: failure.detail
      })
      continue
    }
    const expiresAt = file.expirationTime ?? ref.expiresAt
    if (file.state !== FileState.ACTIVE || !file.uri || expiresTooSoon(expiresAt, deps.now())) {
      continue
    }
    return {
      name: file.name ?? ref.name,
      uri: file.uri,
      mimeType: file.mimeType ?? ref.mimeType,
      expiresAt: expiresAt ?? null
    }
  }
  return null
}

export interface ProxyUpload {
  apiKey: string
  path: string
  displayName: string
  signal?: AbortSignal
  /** 0..1, or -1 while the progress is unknown (SDK fallback) */
  onProgress: (fraction: number) => void
  /** receives cleanup that runs on after the upload gave up (see AnalyzeRequest.onCleanup) */
  onCleanup?: (cleanup: Promise<void>) => void
  /** resumable session to continue; a new session is recorded in it (default: a new one) */
  session?: UploadSession
}

/**
 * Uploads the proxy (own resumable uploader, SDK as fallback), retrying transient failures. All
 * attempts share one upload session, so a retry continues where the last attempt stopped.
 */
export async function uploadProxy(
  client: GenAiClient,
  upload: ProxyUpload,
  deps: FileDeps
): Promise<GeminiFile> {
  const session = upload.session ?? { url: null }
  try {
    return await withRetries(() => uploadOnce(client, upload, session, deps), {
      sleep: deps.sleep,
      random: deps.random,
      signal: upload.signal,
      onRetry: (failure, attempt, delayMs) =>
        deps.logger.warn('upload failed, retrying', {
          kind: failure.kind,
          detail: failure.detail,
          attempt,
          delayMs
        })
    })
  } catch (err) {
    // "not found" from the upload endpoint concerns this upload, not the key or the model
    if (isFileNotFound(err)) {
      throw new AnalyzerError('upload', MESSAGES.upload, { retryable: true, cause: err })
    }
    if (classifyError(err, upload.signal).kind !== 'unknown') throw err
    const missing = (err as { code?: unknown } | null)?.code === 'ENOENT'
    throw new AnalyzerError('upload', missing ? MESSAGES.proxyMissing : MESSAGES.upload, {
      retryable: !missing,
      cause: err
    })
  }
}

async function uploadOnce(
  client: GenAiClient,
  upload: ProxyUpload,
  session: UploadSession,
  deps: FileDeps
): Promise<GeminiFile> {
  try {
    return await uploadResumable({
      apiKey: upload.apiKey,
      filePath: upload.path,
      mimeType: PROXY_MIME_TYPE,
      displayName: upload.displayName,
      baseUrl: deps.uploadBaseUrl,
      fetch: deps.fetch,
      sleep: deps.sleep,
      now: deps.now,
      chunkSize: deps.chunkSize,
      signal: upload.signal,
      onProgress: upload.onProgress,
      session
    })
  } catch (err) {
    if (!(err instanceof UploadProtocolError)) throw err
    deps.logger.warn('resumable upload failed, falling back to the SDK uploader', {
      detail: err.message
    })
    upload.onProgress(-1)
    return uploadWithSdk(client, upload, deps.logger)
  }
}

async function uploadWithSdk(
  client: GenAiClient,
  upload: ProxyUpload,
  logger: AnalyzerLogger
): Promise<GeminiFile> {
  // a Blob avoids the SDK's file-name header (throws for non-Latin-1 names); never pass
  // config.httpOptions here – it breaks the upload start request in SDK 2.32
  const blob = await openAsBlob(upload.path, { type: PROXY_MIME_TYPE })
  const pending = client.files.upload({
    file: blob,
    config: { mimeType: PROXY_MIME_TYPE, displayName: upload.displayName }
  })
  try {
    const file = await untilAborted(pending, upload.signal)
    upload.onProgress(1)
    return file
  } catch (err) {
    if (upload.signal?.aborted) {
      // files.upload ignores abort signals: remove the file once the orphaned upload lands (the
      // caller tracks it, so quitting the app waits for it)
      const cleanup = pending.then(
        (file) => (file.name ? deleteQuietly(client, file.name, logger) : undefined),
        () => undefined
      )
      upload.onCleanup?.(cleanup)
    }
    throw err
  }
}

/** Polls until Gemini has processed the upload (FAILED or timeout → processing error). */
export async function waitUntilActive(
  client: GenAiClient,
  uploaded: GeminiFile,
  deps: FileDeps,
  signal?: AbortSignal
): Promise<ActiveFile> {
  const name = uploaded.name
  if (!name || !isGeminiFileName(name)) {
    throw new AnalyzerError('upload', MESSAGES.upload, {
      retryable: true,
      cause: new Error('upload returned no valid file name')
    })
  }
  const deadline = deps.now() + deps.processingTimeoutMs
  let file = uploaded
  for (;;) {
    if (file.state === FileState.ACTIVE) return activeFile(name, file, uploaded)
    if (file.state === FileState.FAILED) {
      throw new AnalyzerError('processing', MESSAGES.processing, {
        retryable: true,
        cause: new Error(`file processing failed: ${file.error?.message ?? 'no reason given'}`)
      })
    }
    // PROCESSING or STATE_UNSPECIFIED: keep polling
    if (deps.now() + deps.pollIntervalMs > deadline) {
      throw new AnalyzerError('processing', MESSAGES.processingTimeout, { retryable: true })
    }
    await deps.sleep(deps.pollIntervalMs, signal)
    file = (await pollFile(client, name, deps.logger, signal)) ?? file
  }
}

function activeFile(name: string, file: GeminiFile, uploaded: GeminiFile): ActiveFile {
  const uri = file.uri ?? uploaded.uri
  if (!uri) {
    throw new AnalyzerError('processing', MESSAGES.processing, {
      retryable: true,
      cause: new Error('ACTIVE file without uri')
    })
  }
  return {
    name,
    uri,
    mimeType: file.mimeType ?? uploaded.mimeType ?? PROXY_MIME_TYPE,
    expiresAt: file.expirationTime ?? uploaded.expirationTime ?? null
  }
}

function getFile(client: GenAiClient, name: string, signal?: AbortSignal): Promise<GeminiFile> {
  return withCallSignal(signal, (callSignal) =>
    client.files.get({
      name,
      config: { abortSignal: callSignal, httpOptions: { timeout: FILE_REQUEST_TIMEOUT_MS } }
    })
  )
}

/** one state poll; transient errors (festival Wi-Fi) just skip it */
async function pollFile(
  client: GenAiClient,
  name: string,
  logger: AnalyzerLogger,
  signal?: AbortSignal
): Promise<GeminiFile | null> {
  try {
    return await getFile(client, name, signal)
  } catch (err) {
    const failure = classifyError(err, signal)
    if (failure.kind !== 'cancelled' && isFileNotFound(err)) throw fileGoneError(err)
    if (!isRetryable(failure)) throw err
    logger.warn('could not read the file state, polling again', { detail: failure.detail })
    return null
  }
}

const DELETED = Symbol('deleted')
const TIMED_OUT = Symbol('timed out')

/** Best-effort delete that never throws and never hangs; a missing file (404/403) counts as deleted. */
export async function deleteQuietly(
  client: GenAiClient,
  name: string,
  logger: AnalyzerLogger
): Promise<void> {
  if (!isGeminiFileName(name)) {
    logger.warn('not deleting a remote file with an invalid name', { name: name.slice(0, 100) })
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), DELETE_TIMEOUT_MS + 1_000)
    timer.unref?.()
  })
  const request = Promise.resolve()
    .then(() =>
      client.files.delete({
        name,
        config: { httpOptions: { timeout: DELETE_TIMEOUT_MS, retryOptions: { attempts: 1 } } }
      })
    )
    .then(
      () => DELETED,
      (err: unknown) => err
    )
  try {
    const outcome = await Promise.race([request, timeout])
    if (outcome === TIMED_OUT) logger.warn('deleting the remote file timed out', { name })
    else if (outcome !== DELETED && !isFileNotFound(outcome)) {
      logger.warn('could not delete the remote file', {
        name,
        detail: classifyError(outcome).detail
      })
    }
  } finally {
    clearTimeout(timer)
  }
}
