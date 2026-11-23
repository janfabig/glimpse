// App-level retries (the SDK's own retries stay off): exponential backoff with jitter, abortable sleeps.
import {
  cancelledError,
  classifyError,
  isRetryable,
  throwIfCancelled,
  type Failure
} from './errors'

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

/** setTimeout-based sleep that rejects with AnalyzerError('cancelled') on abort */
export const sleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError())
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(cancelledError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export const MAX_ATTEMPTS = 4
/** a timed-out request already waited 10–20 min: try once more at most */
const TIMEOUT_ATTEMPTS = 2
const BACKOFF_BASE_MS = 2_000
/** per-minute quotas need longer pauses, and RetryInfo hints are known to be too optimistic */
const QUOTA_BACKOFF_BASE_MS = 10_000
const BACKOFF_CAP_MS = 60_000
/** server hints beyond this are effectively "come back later" – fail instead of blocking the queue */
const MAX_SERVER_HINT_MS = 120_000

/** Wait before the next attempt; null = do not retry. Equal jitter: [cap/2, cap). */
export function retryDelayMs(
  failure: Failure,
  attempt: number,
  random: () => number
): number | null {
  const base = failure.kind === 'quota-minute' ? QUOTA_BACKOFF_BASE_MS : BACKOFF_BASE_MS
  const cap = Math.min(BACKOFF_CAP_MS, base * 2 ** (attempt - 1))
  const backoff = cap / 2 + random() * (cap / 2)
  const hint = failure.retryAfterMs
  if (hint === undefined) return Math.round(backoff)
  if (hint > MAX_SERVER_HINT_MS) return null
  return Math.round(Math.max(backoff, hint + random() * 1_000))
}

export interface RetryOptions {
  sleep: Sleep
  random: () => number
  signal?: AbortSignal
  /** default 4 (including the first attempt) */
  maxAttempts?: number
  onRetry?: (failure: Failure, attempt: number, delayMs: number) => void
}

/** Runs `operation` until it succeeds or fails with something a retry cannot fix. */
export async function withRetries<T>(
  operation: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS
  for (let attempt = 1; ; attempt++) {
    throwIfCancelled(options.signal)
    try {
      return await operation()
    } catch (err) {
      const failure = classifyError(err, options.signal)
      const limit =
        failure.kind === 'timeout' ? Math.min(maxAttempts, TIMEOUT_ATTEMPTS) : maxAttempts
      const delayMs =
        attempt < limit && isRetryable(failure)
          ? retryDelayMs(failure, attempt, options.random)
          : null
      if (delayMs === null) throw err
      options.onRetry?.(failure, attempt, delayMs)
      await options.sleep(delayMs, options.signal)
    }
  }
}

/**
 * Gives an SDK call its own AbortSignal linked to `parent`: the SDK leaves listeners on signals it is
 * handed, so a request-wide signal must not be passed to many calls directly.
 */
export async function withCallSignal<T>(
  parent: AbortSignal | undefined,
  call: (signal: AbortSignal | undefined) => Promise<T>
): Promise<T> {
  if (!parent) return call(undefined)
  throwIfCancelled(parent)
  const controller = new AbortController()
  const abort = (): void => controller.abort(parent.reason)
  parent.addEventListener('abort', abort, { once: true })
  try {
    return await call(controller.signal)
  } finally {
    parent.removeEventListener('abort', abort)
  }
}

/** Resolves like `promise`, but rejects with AnalyzerError('cancelled') as soon as `signal` aborts. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelledError())
      return
    }
    const onAbort = (): void => reject(cancelledError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}
