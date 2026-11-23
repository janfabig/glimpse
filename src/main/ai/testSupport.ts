// Test doubles for the ai module (imported by *.test.ts only): SDK client, resumable-upload server,
// logger, sleep, temp files. Nothing here touches the network.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ApiError,
  BlockedReason,
  FinishReason,
  MediaModality,
  type File as GeminiFile,
  type GenerateContentParameters,
  type Model
} from '@google/genai'
import type { GenAiClient, GenerateResult } from './client'
import { cancelledError } from './errors'
import type { AnalyzerLogger } from './logger'
import type { Sleep } from './retry'
import type { FetchLike } from './upload'
import { formatClock } from './util'

// ---------------------------------------------------------------------------
// logger, sleep, clock
// ---------------------------------------------------------------------------

export interface LogEntry {
  level: 'info' | 'warn'
  message: string
  data?: Record<string, unknown>
}

export function recordingLogger(): AnalyzerLogger & { entries: LogEntry[] } {
  const entries: LogEntry[] = []
  return {
    entries,
    info: (message, data) => entries.push({ level: 'info', message, data }),
    warn: (message, data) => entries.push({ level: 'warn', message, data })
  }
}

/** Resolves immediately (rejects when aborted), records the requested delays and advances `clock`. */
export function instantSleep(clock?: { now: number }): { sleep: Sleep; delays: number[] } {
  const delays: number[] = []
  const sleep: Sleep = async (ms, signal) => {
    if (signal?.aborted) throw cancelledError()
    delays.push(ms)
    if (clock) clock.now += ms
    await Promise.resolve()
    if (signal?.aborted) throw cancelledError()
  }
  return { sleep, delays }
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/** an ApiError exactly like @google/genai builds it from a JSON error body */
export function apiError(
  status: number,
  error: { message?: string; status?: string; details?: unknown[] } = {}
): ApiError {
  const body = {
    error: {
      code: status,
      message: error.message ?? `HTTP ${status}`,
      status: error.status ?? 'UNKNOWN',
      ...(error.details ? { details: error.details } : {})
    }
  }
  return new ApiError({ message: JSON.stringify(body), status })
}

/** undici's shape of a dropped connection */
export function networkError(code = 'ECONNRESET'): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error(`read ${code}`), { code })
  })
}

export function abortError(): Error {
  return new DOMException('This operation was aborted', 'AbortError')
}

// ---------------------------------------------------------------------------
// generateContent responses
// ---------------------------------------------------------------------------

export interface ResultOptions {
  /** open strings: the REST API sends values the SDK enums lack */
  finishReason?: string
  blockReason?: string
  /** VIDEO prompt tokens (default: plenty) */
  videoTokens?: number
  /** false → no usageMetadata at all */
  usage?: boolean
  thought?: string
}

/** A generateContent result whose text is `payload` (JSON-encoded unless it is a string). */
export function generateResult(payload: unknown, options: ResultOptions = {}): GenerateResult {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const videoTokens = options.videoTokens ?? 50_000
  return {
    ...(options.blockReason
      ? { promptFeedback: { blockReason: options.blockReason as BlockedReason } }
      : {}),
    candidates: options.blockReason
      ? []
      : [
          {
            finishReason: (options.finishReason ?? FinishReason.STOP) as FinishReason,
            content: {
              role: 'model',
              parts: [
                ...(options.thought ? [{ text: options.thought, thought: true }] : []),
                { text }
              ]
            }
          }
        ],
    ...(options.usage === false
      ? {}
      : {
          usageMetadata: {
            promptTokenCount: videoTokens + 1_500,
            candidatesTokenCount: 400,
            thoughtsTokenCount: 900,
            totalTokenCount: videoTokens + 2_800,
            promptTokensDetails: [
              { modality: MediaModality.VIDEO, tokenCount: videoTokens },
              { modality: MediaModality.TEXT, tokenCount: 1_500 }
            ]
          }
        })
  }
}

/** a well-formed answer for a video of `durationSec`: one moment, all a video of up to a minute gets */
export function validPayload(durationSec = 60): unknown {
  return {
    videoEndsAt: formatClock(durationSec),
    moments: [
      {
        start: '00:05',
        peak: '00:07',
        end: '00:10',
        title: 'Drop with light show',
        reason: 'The drop hits.',
        score: 9
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// SDK client
// ---------------------------------------------------------------------------

type Handler<A extends unknown[], R> = (...args: A) => R | Promise<R>

export interface FakeClientOptions {
  generate?: Handler<[params: GenerateContentParameters, call: number], GenerateResult>
  getFile?: Handler<[name: string, call: number, signal?: AbortSignal], GeminiFile>
  upload?: Handler<[params: { file: unknown; config?: unknown }], GeminiFile>
  deleteFile?: Handler<[name: string], unknown>
  models?: Model[] | Handler<[], AsyncIterable<Model>>
}

export interface FakeClient extends GenAiClient {
  calls: {
    generate: GenerateContentParameters[]
    get: string[]
    upload: { file: unknown; config?: unknown }[]
    delete: string[]
    list: number
  }
}

export function fakeClient(options: FakeClientOptions = {}): FakeClient {
  const calls: FakeClient['calls'] = { generate: [], get: [], upload: [], delete: [], list: 0 }
  return {
    calls,
    models: {
      generateContent: async (params) => {
        calls.generate.push(params)
        if (!options.generate) return generateResult(validPayload())
        return options.generate(params, calls.generate.length)
      },
      list: async () => {
        calls.list++
        const models = options.models ?? []
        if (typeof models === 'function') return models()
        return (async function* () {
          yield* models
        })()
      }
    },
    files: {
      upload: async (params) => {
        calls.upload.push(params)
        if (!options.upload) throw new Error('unexpected SDK upload')
        return options.upload(params)
      },
      get: async ({ name, config }) => {
        calls.get.push(name)
        if (!options.getFile) return activeFile({ name })
        return options.getFile(name, calls.get.length, config?.abortSignal)
      },
      delete: async ({ name }) => {
        calls.delete.push(name)
        return options.deleteFile ? options.deleteFile(name) : {}
      }
    }
  }
}

export function activeFile(overrides: Partial<GeminiFile> = {}): GeminiFile {
  return {
    name: 'files/abc123',
    uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123',
    mimeType: 'video/mp4',
    state: 'ACTIVE' as GeminiFile['state'],
    expirationTime: '2026-11-03T12:00:00Z',
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// resumable upload server
// ---------------------------------------------------------------------------

export const UPLOAD_BASE = 'https://upload.test'
const SESSION_URL = `${UPLOAD_BASE}/upload/v1beta/files?upload_id=session-1`

export interface RecordedRequest {
  url: string
  command: string
  offset: number | null
  headers: Record<string, string>
  bytes: number
  body: string | null
}

export interface UploadServerOptions {
  /** file returned on finalize */
  file?: Partial<GeminiFile>
  /** HTTP error on the start request */
  startError?: { status: number; body: string }
  omitUploadUrl?: boolean
  /** replaces x-goog-upload-status of the n-th chunk response (0-based) */
  chunkStatus?: (index: number) => string | null | undefined
  /** HTTP error for the n-th chunk */
  chunkError?: (index: number) => { status: number; body: string } | undefined
  /** chunks whose request fails like a dropped connection; `kept` bytes reach the server first */
  drop?: { index: number; kept: number }[]
  /** answer for "query" (default: supported) */
  queryStatus?: number
  /** false → the query answer lacks x-goog-upload-size-received */
  querySize?: boolean
  /** called before each chunk is processed (e.g. to abort) */
  onChunk?: (index: number) => void
  finalBody?: unknown
  /** chunks whose request never answers until it is aborted – a stalled connection */
  hang?: (index: number) => boolean
  /** chunks the server stores (and finalizes) completely, but whose response never arrives */
  loseResponse?: (index: number) => boolean
  /**
   * Festival Wi-Fi: once the chunk with index `atChunk` is sent, every request (start, chunk, query)
   * fails like an unreachable network until `durationMs` of `now` time have passed.
   */
  outage?: { atChunk: number; durationMs: number }
  /** clock for `outage` (default: Date.now) */
  now?: () => number
}

export interface UploadServer {
  fetch: FetchLike
  requests: RecordedRequest[]
  /** bytes the server stored, in order */
  received: () => Buffer
}

export function uploadServer(options: UploadServerOptions = {}): UploadServer {
  const requests: RecordedRequest[] = []
  let stored = Buffer.alloc(0)
  let chunkIndex = 0
  /** body of the finalize response once the upload is complete */
  let finalized: unknown = null
  let outageEnd: number | null = null
  const now = options.now ?? Date.now
  const fetch: FetchLike = async (url, init) => {
    const headers = new Headers(init.headers)
    const command = headers.get('x-goog-upload-command') ?? ''
    const raw = init.body
    const bytes = raw instanceof Uint8Array ? Buffer.from(raw) : Buffer.alloc(0)
    const offsetHeader = headers.get('x-goog-upload-offset')
    requests.push({
      url,
      command,
      offset: offsetHeader === null ? null : Number(offsetHeader),
      headers: Object.fromEntries(headers.entries()),
      bytes: bytes.length,
      body: typeof raw === 'string' ? raw : null
    })
    if (init.signal?.aborted) throw abortError()
    if (options.outage) {
      const isChunk = command.startsWith('upload')
      if (outageEnd === null && isChunk && chunkIndex === options.outage.atChunk) {
        outageEnd = now() + options.outage.durationMs
      }
      if (outageEnd !== null && now() < outageEnd) throw networkError('ENETUNREACH')
    }

    if (command === 'start') {
      if (options.startError) {
        return new Response(options.startError.body, { status: options.startError.status })
      }
      stored = Buffer.alloc(0)
      finalized = null
      return new Response(null, {
        status: 200,
        headers: options.omitUploadUrl ? {} : { 'x-goog-upload-url': SESSION_URL }
      })
    }
    if (command === 'query') {
      if (options.queryStatus && options.queryStatus !== 200) {
        return new Response('{"error":{"message":"query not supported"}}', {
          status: options.queryStatus
        })
      }
      if (finalized) {
        return new Response(JSON.stringify(finalized), {
          status: 200,
          headers: { 'x-goog-upload-status': 'final', 'content-type': 'application/json' }
        })
      }
      return new Response(null, {
        status: 200,
        headers: {
          'x-goog-upload-status': 'active',
          ...(options.querySize === false
            ? {}
            : { 'x-goog-upload-size-received': String(stored.length) })
        }
      })
    }

    const index = chunkIndex++
    options.onChunk?.(index)
    if (init.signal?.aborted) throw abortError()
    if (options.hang?.(index)) {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(abortError()), { once: true })
      })
    }
    const offset = Number(offsetHeader)
    if (offset !== stored.length) {
      return new Response(`offset ${offset} does not match ${stored.length}`, { status: 400 })
    }
    const drop = options.drop?.find((d) => d.index === index)
    if (drop) {
      stored = Buffer.concat([stored, bytes.subarray(0, drop.kept)])
      throw networkError()
    }
    const error = options.chunkError?.(index)
    if (error) return new Response(error.body, { status: error.status })
    stored = Buffer.concat([stored, bytes])
    const finalize = command.includes('finalize')
    const override = options.chunkStatus?.(index)
    const status = override === undefined ? (finalize ? 'final' : 'active') : override
    const responseHeaders: Record<string, string> = status ? { 'x-goog-upload-status': status } : {}
    let response: Response
    if (!finalize || status !== 'final') {
      response = new Response(null, { status: 200, headers: responseHeaders })
    } else {
      const body = options.finalBody ?? {
        file: {
          name: 'files/abc123',
          uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123',
          mimeType: 'video/mp4',
          state: 'PROCESSING',
          sizeBytes: String(stored.length),
          expirationTime: '2026-11-03T12:00:00Z',
          ...options.file
        }
      }
      finalized = body
      response = new Response(JSON.stringify(body), {
        status: 200,
        headers: { ...responseHeaders, 'content-type': 'application/json' }
      })
    }
    if (options.loseResponse?.(index)) throw networkError()
    return response
  }
  return { fetch, requests, received: () => stored }
}

/** number of upload sessions the client started */
export function sessionCount(server: UploadServer): number {
  return server.requests.filter((r) => r.command === 'start').length
}

/** bytes sent in chunk requests (including failed ones), relative to `size` */
export function sentShare(server: UploadServer, size: number): number {
  const sent = server.requests
    .filter((r) => r.command.startsWith('upload'))
    .reduce((sum, r) => sum + r.bytes, 0)
  return sent / size
}

// ---------------------------------------------------------------------------
// live test gate
// ---------------------------------------------------------------------------

/**
 * API key for the live Gemini test, or null to skip it. It needs an explicit HC_LIVE_GEMINI=1:
 * GEMINI_API_KEY alone is the app's documented key fallback, so developers often have it set, and a
 * live run uploads a clip and uses up quota.
 */
export function liveGeminiKey(
  env: Record<string, string | undefined> = process.env
): string | null {
  const key = env.GEMINI_API_KEY?.trim()
  return env.HC_LIVE_GEMINI === '1' && key ? key : null
}

// ---------------------------------------------------------------------------
// temp files
// ---------------------------------------------------------------------------

export interface TempFile {
  path: string
  content: Buffer
  remove: () => Promise<void>
}

/** a file with deterministic bytes */
export async function tempFile(size: number, name = 'proxy.mp4'): Promise<TempFile> {
  const dir = await mkdtemp(join(tmpdir(), 'hc-ai-test-'))
  const path = join(dir, name)
  const content = Buffer.alloc(size)
  for (let i = 0; i < size; i++) content[i] = (i * 31 + 7) % 251
  await writeFile(path, content)
  return { path, content, remove: () => rm(dir, { recursive: true, force: true }) }
}
