// Error classification (what went wrong, may we retry?) and mapping to AnalyzerError with a text for the user.
import { isRecord } from '@shared/util'
import { AnalyzerError } from '../contracts'
import { MESSAGES } from './messages'
import { dailyQuotaAlternative, freeTierAlternative, modelLabel } from './models'
import { truncate } from './util'

export type FailureKind =
  | 'cancelled'
  /** an AnalyzerError raised by our own checks – already final */
  | 'final'
  | 'auth'
  /** HTTP 402: prepaid balance used up */
  | 'billing'
  | 'model'
  /** 403/404 naming a Files API file: it expired, was deleted or belongs to another project */
  | 'file'
  | 'quota-minute'
  | 'quota-day'
  /** free tier has no quota for the model ("limit: 0") */
  | 'quota-paid-only'
  | 'network'
  | 'timeout'
  | 'server'
  /** any other 4xx: the API refused the request */
  | 'rejected'
  | 'unknown'

export interface Failure {
  kind: FailureKind
  /** HTTP status of an API error */
  status?: number
  /** server wait hint (google.rpc.RetryInfo) */
  retryAfterMs?: number
  /** short English diagnostic for logs; secrets redacted */
  detail: string
}

const TRANSIENT: ReadonlySet<FailureKind> = new Set([
  'network',
  'timeout',
  'server',
  'quota-minute'
])

/** transient failures that an app-level retry may fix */
export function isRetryable(failure: Failure): boolean {
  return TRANSIENT.has(failure.kind)
}

export function cancelledError(): AnalyzerError {
  return new AnalyzerError('cancelled', MESSAGES.cancelled)
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError()
}

/** Problems with the model's answer that justify asking once more (see generate.ts). */
export type ContentProblemKind = 'empty' | 'truncated' | 'stopped' | 'format' | 'video-not-seen'

export class ContentProblem extends Error {
  readonly kind: ContentProblemKind
  constructor(kind: ContentProblemKind, detail: string) {
    super(detail)
    this.name = 'ContentProblem'
    this.kind = kind
  }

  toAnalyzerError(): AnalyzerError {
    return this.kind === 'video-not-seen'
      ? new AnalyzerError('processing', MESSAGES.videoNotSeen, { retryable: true, cause: this })
      : new AnalyzerError('invalid-response', MESSAGES.invalidResponse, {
          retryable: true,
          cause: this
        })
  }
}

// ---------------------------------------------------------------------------
// SDK ApiError parsing
// ---------------------------------------------------------------------------

export interface ApiErrorInfo {
  status: number
  /** e.g. RESOURCE_EXHAUSTED, INVALID_ARGUMENT */
  apiStatus?: string
  message: string
  /** google.rpc.ErrorInfo reasons, e.g. API_KEY_INVALID */
  reasons: string[]
  /** google.rpc.QuotaFailure quota ids, e.g. GenerateRequestsPerDayPerProjectPerModel-FreeTier */
  quotaIds: string[]
  retryAfterMs?: number
}

/** Reads an `ApiError` of @google/genai (or one we built the same way); null for other errors. */
export function apiErrorInfo(err: unknown): ApiErrorInfo | null {
  if (!(err instanceof Error) || err.name !== 'ApiError') return null
  const status = (err as { status?: unknown }).status
  if (typeof status !== 'number') return null
  // the SDK puts the JSON error body into the message (streams prefix it with "got status: …")
  const body = parseEmbeddedJson(err.message)
  const error = isRecord(body) && isRecord(body.error) ? body.error : null
  const info: ApiErrorInfo = {
    status,
    message: typeof error?.message === 'string' ? error.message : err.message,
    reasons: [],
    quotaIds: []
  }
  if (typeof error?.status === 'string') info.apiStatus = error.status
  const details = Array.isArray(error?.details) ? error.details : []
  for (const detail of details) {
    if (!isRecord(detail)) continue
    const type = typeof detail['@type'] === 'string' ? detail['@type'] : ''
    if (type.endsWith('RetryInfo')) {
      info.retryAfterMs = parseDurationMs(detail.retryDelay) ?? info.retryAfterMs
    } else if (type.endsWith('QuotaFailure') && Array.isArray(detail.violations)) {
      for (const violation of detail.violations) {
        if (isRecord(violation) && typeof violation.quotaId === 'string') {
          info.quotaIds.push(violation.quotaId)
        }
      }
    } else if (type.endsWith('ErrorInfo') && typeof detail.reason === 'string') {
      info.reasons.push(detail.reason)
    }
  }
  return info
}

function parseEmbeddedJson(text: string): unknown {
  const start = text.indexOf('{')
  if (start < 0) return null
  try {
    return JSON.parse(text.slice(start))
  } catch {
    return null
  }
}

/** protobuf Duration JSON ("33s", "0.5s") → ms */
function parseDurationMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim())
  return match ? Math.ceil(Number(match[1]) * 1000) : undefined
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED'
])

function isNetworkError(err: unknown): boolean {
  // undici wraps connection problems as `TypeError: fetch failed` with the system error as `cause`
  let current: unknown = err
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && NETWORK_CODES.has(code)) return true
    current = (current as { cause?: unknown }).cause
  }
  return (
    err instanceof TypeError &&
    /fetch failed|terminated|network|socket|net::ERR_/i.test(err.message)
  )
}

function isAbortLike(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const name = (err as { name?: unknown }).name
  return name === 'AbortError' || name === 'TimeoutError'
}

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as { cause?: unknown }).cause
  const code =
    typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined
  return `${err.name}: ${err.message}${typeof code === 'string' ? ` (${code})` : ''}`
}

/** API keys must never end up in logs or user-facing texts. */
export function redactSecrets(text: string): string {
  return text.replace(/AIza[0-9A-Za-z_-]{10,}/g, 'AIza…')
}

/** "You do not have permission to access the File abc or it may not exist." */
const NAMES_FILE = /\bFile\b|\bfiles\//
/** "models/gemini-9 is not found for API version v1beta, or is not supported for …", "Model … not found" */
const NAMES_MODEL = /\bmodels\/|\bmodel\b/i

function classifyApiError(info: ApiErrorInfo): Failure {
  const base = {
    status: info.status,
    detail: redactSecrets(
      `HTTP ${info.status}${info.apiStatus ? ` ${info.apiStatus}` : ''}: ${info.message}`
    )
  }
  const text = `${info.message} ${info.reasons.join(' ')}`
  if (/API_KEY_INVALID|API key (?:not valid|expired|invalid)/i.test(text)) {
    return { kind: 'auth', ...base }
  }
  // checked before the status rules: a vanished file is neither a key nor a model problem
  if ((info.status === 403 || info.status === 404) && NAMES_FILE.test(info.message)) {
    return { kind: 'file', ...base }
  }
  if (info.status === 401 || info.status === 403) return { kind: 'auth', ...base }
  if (info.status === 402) return { kind: 'billing', ...base }
  if (info.status === 404) {
    return { kind: NAMES_MODEL.test(info.message) ? 'model' : 'rejected', ...base }
  }
  if (info.status === 429) {
    if (/limit:\s*0\b/.test(info.message)) return { kind: 'quota-paid-only', ...base }
    if ([...info.quotaIds, info.message].some((t) => /per\s*day|daily/i.test(t))) {
      return { kind: 'quota-day', ...base }
    }
    return { kind: 'quota-minute', retryAfterMs: info.retryAfterMs, ...base }
  }
  if (info.status === 400 && /model/i.test(info.message) && /not (?:found|supported)/i.test(text)) {
    return { kind: 'model', ...base }
  }
  if (info.status === 408) return { kind: 'timeout', ...base }
  if (info.status === 499 || info.status >= 500) {
    return { kind: 'server', retryAfterMs: info.retryAfterMs, ...base }
  }
  return { kind: 'rejected', ...base }
}

export function classifyError(err: unknown, signal?: AbortSignal): Failure {
  if (err instanceof AnalyzerError) {
    return { kind: err.code === 'cancelled' ? 'cancelled' : 'final', detail: err.message }
  }
  if (signal?.aborted) return { kind: 'cancelled', detail: 'aborted by the caller' }
  const api = apiErrorInfo(err)
  if (api) return classifyApiError(api)
  // aborts we did not ask for come from the SDK's per-request timeout
  if (isAbortLike(err)) return { kind: 'timeout', detail: redactSecrets(describe(err)) }
  if (isNetworkError(err)) return { kind: 'network', detail: redactSecrets(describe(err)) }
  return { kind: 'unknown', detail: redactSecrets(describe(err)) }
}

/**
 * For Files API calls (get, upload), where the file or the upload endpoint is the only thing that
 * can be missing: any 404, or a 403 that names the file. Such an answer says nothing about the
 * key or the model, which the plain classification would assume.
 */
export function isFileNotFound(err: unknown): boolean {
  const info = apiErrorInfo(err)
  return info !== null && (info.status === 404 || classifyApiError(info).kind === 'file')
}

/** The uploaded proxy vanished on Google's side: a fresh upload on the next attempt fixes it. */
export function fileGoneError(cause: unknown): AnalyzerError {
  return new AnalyzerError('processing', MESSAGES.fileGone, { retryable: true, cause })
}

// ---------------------------------------------------------------------------
// AnalyzerError mapping
// ---------------------------------------------------------------------------

export interface ErrorContext {
  signal?: AbortSignal
  /** model id of the request, for messages such as "The model “…” is not available" */
  model?: string
}

export function toAnalyzerError(err: unknown, context: ErrorContext = {}): AnalyzerError {
  if (context.signal?.aborted) {
    return err instanceof AnalyzerError && err.code === 'cancelled' ? err : cancelledError()
  }
  if (err instanceof AnalyzerError) return err
  const failure = classifyError(err)
  const label = modelLabel(context.model)
  const make = (code: AnalyzerError['code'], message: string, retryable: boolean): AnalyzerError =>
    new AnalyzerError(code, message, { retryable, cause: err })
  switch (failure.kind) {
    case 'cancelled':
      return cancelledError()
    case 'auth':
      return make('auth', MESSAGES.auth, false)
    case 'billing':
      return make('quota', MESSAGES.billing, false)
    case 'model':
      return make('model', MESSAGES.model(label), false)
    case 'file':
      return fileGoneError(err)
    case 'quota-minute':
      return make('quota', MESSAGES.quotaMinute, true)
    case 'quota-day':
      return make('quota', MESSAGES.quotaDay(dailyQuotaAlternative(context.model)), false)
    case 'quota-paid-only':
      return make('quota', MESSAGES.paidOnly(label, freeTierAlternative(context.model)), false)
    case 'network':
      return make('network', MESSAGES.network, true)
    case 'timeout':
      return make('network', MESSAGES.timeout, true)
    case 'server':
      return make('network', MESSAGES.server, true)
    case 'rejected': {
      const apiMessage = apiErrorInfo(err)?.message ?? failure.detail
      return make('unknown', MESSAGES.rejected(truncate(redactSecrets(apiMessage), 160)), false)
    }
    case 'final':
    case 'unknown':
      return make('unknown', MESSAGES.unknown, true)
  }
}
