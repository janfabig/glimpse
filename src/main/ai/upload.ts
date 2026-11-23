// Files API upload with progress, cancel and resume. Same wire protocol as the SDK's files.upload
// (which has none of these), verified against a mock in docs/research/gemini.md:
//   1. POST {base}/upload/v1beta/files (X-Goog-Upload-Command: start) → header x-goog-upload-url
//   2. POST <upload url> per chunk (X-Goog-Upload-Command: upload | "upload, finalize",
//      X-Goog-Upload-Offset) → x-goog-upload-status active | final (+ body {"file": File})
//   3. POST <upload url> (X-Goog-Upload-Command: query) → x-goog-upload-status and
//      x-goog-upload-size-received: where to continue after a dropped or stalled chunk
// Festival Wi-Fi: a dropped connection never throws the session away. The status query is repeated
// for about two minutes, a stalled chunk is given up after a timeout that follows the measured speed,
// and a later attempt that gets the same UploadSession continues instead of starting at byte 0.
import { open, stat, type FileHandle } from 'node:fs/promises'
import { ApiError, type File as GeminiFile } from '@google/genai'
import { clamp, isRecord } from '@shared/util'
import { AnalyzerError } from '../contracts'
import { classifyError, throwIfCancelled, type FailureKind } from './errors'
import { MESSAGES } from './messages'
import type { Sleep } from './retry'

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024
/** non-final chunks must be multiples of this */
export const CHUNK_GRANULARITY = 256 * 1024
/** how long the status query is repeated while the network is away */
export const RECOVERY_WINDOW_MS = 2 * 60_000
/** pauses between status queries: 1 s, 2 s, 4 s, 8 s, then every 15 s */
const QUERY_PAUSE_MIN_MS = 1_000
const QUERY_PAUSE_MAX_MS = 15_000
/** resumes in a row after which the server still has not received anything new */
const MAX_STALLED_RESUMES = 3
/** safety net against endless resume loops on a link that drops all the time */
const MAX_RESUMES = 50
/** a chunk always gets this long (the finalize request also waits for the server) */
export const CHUNK_TIMEOUT_MIN_MS = 30_000
const CHUNK_TIMEOUT_MAX_MS = 10 * 60_000
/** assumed speed until a chunk has been measured: 64 KiB/s (≈ 0.5 Mbit/s) */
const INITIAL_MS_PER_BYTE = 1_000 / (64 * 1024)
/** a chunk may take this many times as long as the previous one before it counts as stalled */
const CHUNK_TIMEOUT_FACTOR = 4
const START_TIMEOUT_MS = 30_000
const QUERY_TIMEOUT_MS = 20_000
const STATUS_HEADER = 'x-goog-upload-status'

/** The server answered in a way this uploader does not understand → fall back to the SDK uploader. */
export class UploadProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'UploadProtocolError'
  }
}

/** A resumable upload session. Hand the same object to the next attempt so it can continue. */
export interface UploadSession {
  /** null until a start request succeeded, and again after the server dropped the session */
  url: string | null
}

export interface ResumableUploadOptions {
  apiKey: string
  filePath: string
  mimeType: string
  /** shown in AI Studio; goes into the JSON body, so any characters are fine */
  displayName: string
  /** e.g. https://generativelanguage.googleapis.com */
  baseUrl: string
  fetch: FetchLike
  sleep: Sleep
  /** clock for the recovery window and the speed measurement (default: Date.now) */
  now?: () => number
  /** default 8 MiB; must be a multiple of 256 KiB */
  chunkSize?: number
  signal?: AbortSignal
  /** 0..1 after every chunk */
  onProgress?: (fraction: number) => void
  /** session of an earlier attempt to continue; a new session is recorded in it (default: new) */
  session?: UploadSession
}

export async function uploadResumable(options: ResumableUploadOptions): Promise<GeminiFile> {
  const chunkSize = options.chunkSize ?? UPLOAD_CHUNK_SIZE
  if (chunkSize <= 0 || chunkSize % CHUNK_GRANULARITY !== 0) {
    throw new RangeError('chunk size must be a positive multiple of 256 KiB')
  }
  throwIfCancelled(options.signal)
  const { size } = await stat(options.filePath)
  const session = options.session ?? { url: null }
  let offset = 0
  if (session.url) {
    const state = await queryUntilAnswered(options, session.url, size, 0)
    if (state.kind === 'final') return finished(state.file, options)
    if (state.kind === 'active') offset = state.received
    else session.url = null
  }
  const url = session.url ?? (await startSession(options, size))
  session.url = url
  const handle = await open(options.filePath, 'r')
  try {
    return await sendChunks(options, handle, session, url, size, chunkSize, offset)
  } finally {
    await handle.close()
  }
}

/**
 * How long one chunk may take before it counts as stalled: four times as long as the last finished
 * chunk needed (before that: 64 KiB/s), doubled after every timeout in a row, within 30 s … 10 min.
 */
export function chunkTimeoutMs(
  length: number,
  msPerByte: number | null,
  timeoutsInARow: number
): number {
  const expected =
    msPerByte === null ? length * INITIAL_MS_PER_BYTE : CHUNK_TIMEOUT_FACTOR * length * msPerByte
  const timeout = clamp(expected * 2 ** timeoutsInARow, CHUNK_TIMEOUT_MIN_MS, CHUNK_TIMEOUT_MAX_MS)
  return Math.round(timeout)
}

async function startSession(options: ResumableUploadOptions, size: number): Promise<string> {
  return withTimeout(options.signal, START_TIMEOUT_MS, async (signal) => {
    const response = await options.fetch(
      `${options.baseUrl.replace(/\/+$/, '')}/upload/v1beta/files`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': options.apiKey,
          'Content-Type': 'application/json',
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(size),
          'X-Goog-Upload-Header-Content-Type': options.mimeType
        },
        body: JSON.stringify({
          file: {
            displayName: options.displayName,
            mimeType: options.mimeType,
            sizeBytes: String(size)
          }
        }),
        signal
      }
    )
    if (!response.ok) throw await httpError(response)
    await drain(response)
    const url = response.headers.get('x-goog-upload-url')
    if (!url) throw new UploadProtocolError('start response without x-goog-upload-url')
    return url
  })
}

async function sendChunks(
  options: ResumableUploadOptions,
  handle: FileHandle,
  session: UploadSession,
  url: string,
  size: number,
  chunkSize: number,
  startOffset: number
): Promise<GeminiFile> {
  const now = options.now ?? Date.now
  let offset = startOffset
  /** where the last resume continued; a resume that gets no further than this is stalled */
  let resumedAt = startOffset
  let resumes = 0
  let stalledResumes = 0
  let timeoutsInARow = 0
  let msPerByte: number | null = null
  options.onProgress?.(size > 0 ? offset / size : 0)
  for (;;) {
    throwIfCancelled(options.signal)
    const length = Math.min(chunkSize, size - offset)
    const finalize = offset + length >= size
    const body = await readChunk(handle, offset, length)
    const started = now()
    let file: GeminiFile | null
    try {
      file = await withTimeout(
        options.signal,
        chunkTimeoutMs(length, msPerByte, timeoutsInARow),
        (signal) => sendChunk(options, url, body, offset, finalize, signal)
      )
    } catch (err) {
      throwIfCancelled(options.signal)
      if (!isConnectionProblem(err)) throw err
      if (err instanceof RequestTimeout) timeoutsInARow++
      resumes++
      const state = await queryUntilAnswered(options, url, size, QUERY_PAUSE_MIN_MS, err)
      if (state.kind === 'final') return finished(state.file, options)
      if (state.kind === 'gone') {
        // the next attempt has to start a new session
        session.url = null
        throw err
      }
      stalledResumes = state.received > resumedAt ? 0 : stalledResumes + 1
      resumedAt = state.received
      if (stalledResumes >= MAX_STALLED_RESUMES || resumes >= MAX_RESUMES) {
        throw connectionLost(err)
      }
      offset = state.received
      options.onProgress?.(size > 0 ? offset / size : 0)
      continue
    }
    if (file) return finished(file, options)
    if (length > 0) msPerByte = Math.max(0, now() - started) / length
    timeoutsInARow = 0
    offset += length
    options.onProgress?.(offset / size)
  }
}

/** One chunk; returns the uploaded file after the final chunk, else null. */
async function sendChunk(
  options: ResumableUploadOptions,
  url: string,
  body: Uint8Array<ArrayBuffer>,
  offset: number,
  finalize: boolean,
  signal: AbortSignal
): Promise<GeminiFile | null> {
  const response = await options.fetch(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': options.apiKey,
      'X-Goog-Upload-Command': finalize ? 'upload, finalize' : 'upload',
      'X-Goog-Upload-Offset': String(offset)
    },
    body,
    signal
  })
  if (!response.ok) throw await httpError(response)
  const status = response.headers.get(STATUS_HEADER)
  if (finalize) {
    if (status !== 'final') {
      await drain(response)
      throw new UploadProtocolError(`upload not finalized (status "${status ?? 'missing'}")`)
    }
    const file = await finalFile(response)
    if (!file) throw new UploadProtocolError('final upload response has no file')
    return file
  }
  await drain(response)
  if (status !== 'active') {
    throw new UploadProtocolError(`unexpected upload status "${status ?? 'missing'}" at ${offset}`)
  }
  return null
}

type SessionState =
  | { kind: 'active'; received: number }
  | { kind: 'final'; file: GeminiFile }
  /** unknown, expired or cancelled session: only a new session helps */
  | { kind: 'gone' }

/**
 * Asks the server how much of the upload it has. While the network is away the question is repeated
 * with growing pauses; after about two minutes without an answer the upload fails (retryable).
 */
async function queryUntilAnswered(
  options: ResumableUploadOptions,
  url: string,
  size: number,
  firstPauseMs: number,
  cause?: unknown
): Promise<SessionState> {
  const now = options.now ?? Date.now
  const deadline = now() + RECOVERY_WINDOW_MS
  let lastError = cause
  let pause = firstPauseMs
  for (;;) {
    if (pause > 0) {
      if (now() + pause > deadline) throw connectionLost(lastError)
      await options.sleep(pause, options.signal)
    }
    try {
      return await querySession(options, url, size)
    } catch (err) {
      throwIfCancelled(options.signal)
      if (!isConnectionProblem(err)) throw err
      lastError = err
    }
    pause = pause === 0 ? QUERY_PAUSE_MIN_MS : Math.min(QUERY_PAUSE_MAX_MS, pause * 2)
  }
}

async function querySession(
  options: ResumableUploadOptions,
  url: string,
  size: number
): Promise<SessionState> {
  return withTimeout(options.signal, QUERY_TIMEOUT_MS, async (signal) => {
    const response = await options.fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': options.apiKey, 'X-Goog-Upload-Command': 'query' },
      signal
    })
    const status = response.headers.get(STATUS_HEADER)
    if (response.ok && status === 'final') {
      // the upload was complete, only the answer to the final chunk got lost
      let file: GeminiFile | null
      try {
        file = await finalFile(response)
      } catch (err) {
        if (err instanceof UploadProtocolError) return { kind: 'gone' }
        throw err
      }
      return file ? { kind: 'final', file } : { kind: 'gone' }
    }
    // a busy or failing server is a verdict for the caller's retries, not a lost session
    if ([408, 429].includes(response.status) || response.status >= 500) {
      throw await httpError(response)
    }
    await drain(response)
    const header = response.headers.get('x-goog-upload-size-received') ?? ''
    const received = /^\d+$/.test(header) ? Number(header) : -1
    const usable = response.ok && status === 'active' && received >= 0 && received <= size
    return usable ? { kind: 'active', received } : { kind: 'gone' }
  })
}

/** The file from the body of a final answer (null when there is none); a dropped body still throws. */
async function finalFile(response: Response): Promise<GeminiFile | null> {
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (err) {
    throw new UploadProtocolError('final upload response is not JSON', { cause: err })
  }
  const file = isRecord(body) ? body.file : undefined
  return isRecord(file) && typeof file.name === 'string' ? (file as GeminiFile) : null
}

function finished(file: GeminiFile, options: ResumableUploadOptions): GeminiFile {
  options.onProgress?.(1)
  return file
}

/** dropped, refused or stalled connections: the session is probably fine, ask where it stands */
function isConnectionProblem(err: unknown): boolean {
  const kind = classifyError(err).kind
  return kind === 'network' || kind === 'timeout'
}

/** The network stayed away: final for this attempt (no more retries), but worth trying again later. */
function connectionLost(cause: unknown): AnalyzerError {
  return new AnalyzerError('network', MESSAGES.network, { retryable: true, cause })
}

/** one request of the upload took longer than allowed (classified as a timeout) */
class RequestTimeout extends Error {
  constructor(ms: number, options?: { cause?: unknown }) {
    super(`upload request took longer than ${ms} ms`, options)
    this.name = 'TimeoutError'
  }
}

/**
 * Runs one request with its own AbortSignal, aborted by the caller's signal or after `ms`. (Handing
 * the request-wide signal to every fetch would also leave one listener per request on it.)
 */
async function withTimeout<T>(
  parent: AbortSignal | undefined,
  ms: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  throwIfCancelled(parent)
  const controller = new AbortController()
  const abort = (): void => controller.abort(parent?.reason)
  parent?.addEventListener('abort', abort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new RequestTimeout(ms))
  }, ms)
  try {
    return await run(controller.signal)
  } catch (err) {
    if (timedOut && !parent?.aborted) throw new RequestTimeout(ms, { cause: err })
    throw err
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', abort)
  }
}

async function readChunk(
  handle: FileHandle,
  offset: number,
  length: number
): Promise<Uint8Array<ArrayBuffer>> {
  const chunk = new Uint8Array(length)
  let read = 0
  while (read < length) {
    const { bytesRead } = await handle.read(chunk, read, length - read, offset + read)
    if (bytesRead === 0) throw new Error(`unexpected end of file at byte ${offset + read}`)
    read += bytesRead
  }
  return chunk
}

/** answers that are real verdicts about the request (not about our protocol handling) */
const PASS_THROUGH: ReadonlySet<FailureKind> = new Set([
  'auth',
  'billing',
  'quota-minute',
  'quota-day',
  'quota-paid-only',
  'network',
  'timeout',
  'server'
])

/** HTTP error → SDK-style ApiError (so the shared classifier applies) or UploadProtocolError. */
async function httpError(response: Response): Promise<Error> {
  const text = await response.text().catch(() => '')
  let message: string
  try {
    JSON.parse(text)
    message = text
  } catch {
    message = JSON.stringify({
      error: {
        code: response.status,
        message: text || response.statusText,
        status: response.statusText
      }
    })
  }
  const error = new ApiError({ message, status: response.status })
  if (PASS_THROUGH.has(classifyError(error).kind)) return error
  return new UploadProtocolError(`upload request failed with HTTP ${response.status}`, {
    cause: error
  })
}

async function drain(response: Response): Promise<void> {
  await response.arrayBuffer().catch(() => undefined)
}
