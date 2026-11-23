import { describe, expect, it, vi } from 'vitest'
import { AnalyzerError } from '../contracts'
import { classifyError } from './errors'
import { retryDelayMs, sleep, untilAborted, withCallSignal, withRetries } from './retry'
import { abortError, apiError, instantSleep, networkError } from './testSupport'

function failingTimes<T>(errors: unknown[], value: T): () => Promise<T> {
  let call = 0
  return async () => {
    const error = errors[call++]
    if (error !== undefined) throw error
    return value
  }
}

describe('withRetries', () => {
  it('retries transient failures with growing delays', async () => {
    const { sleep: fakeSleep, delays } = instantSleep()
    const operation = vi.fn(failingTimes([networkError(), apiError(503), networkError()], 'ok'))
    const result = await withRetries(operation, { sleep: fakeSleep, random: () => 0.5 })
    expect(result).toBe('ok')
    expect(operation).toHaveBeenCalledTimes(4)
    expect(delays).toEqual([1_500, 3_000, 6_000])
  })

  it('gives up after four attempts with the last error', async () => {
    const { sleep: fakeSleep, delays } = instantSleep()
    const last = networkError('ETIMEDOUT')
    const operation = vi.fn(
      failingTimes([networkError(), networkError(), networkError(), last], 'ok')
    )
    await expect(withRetries(operation, { sleep: fakeSleep, random: () => 0 })).rejects.toBe(last)
    expect(operation).toHaveBeenCalledTimes(4)
    expect(delays).toHaveLength(3)
  })

  it.each([
    ['auth', apiError(401)],
    ['model', apiError(404)],
    ['per-day quota', apiError(429, { message: 'quota per day exceeded' })],
    ['paid-only model', apiError(429, { message: 'limit: 0' })],
    ['safety', new AnalyzerError('safety', 'blocked')],
    ['rejected request', apiError(400, { message: 'Invalid argument.' })],
    ['bug', new TypeError('x is not a function')]
  ])('never retries %s', async (_label, error) => {
    const { sleep: fakeSleep } = instantSleep()
    const operation = vi.fn(failingTimes([error], 'ok'))
    await expect(withRetries(operation, { sleep: fakeSleep, random: () => 0.5 })).rejects.toBe(
      error
    )
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('honours RetryInfo for per-minute quotas', async () => {
    const { sleep: fakeSleep, delays } = instantSleep()
    const quota = apiError(429, {
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '33s' }]
    })
    await withRetries(failingTimes([quota], 'ok'), { sleep: fakeSleep, random: () => 0 })
    expect(delays).toEqual([33_000])
  })

  it('waits at least the quota backoff when the hint is tiny', async () => {
    const { sleep: fakeSleep, delays } = instantSleep()
    const quota = apiError(429, {
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1s' }]
    })
    await withRetries(failingTimes([quota], 'ok'), { sleep: fakeSleep, random: () => 0 })
    expect(delays[0]).toBeGreaterThanOrEqual(5_000)
  })

  it('does not wait for hints of several minutes', async () => {
    const { sleep: fakeSleep } = instantSleep()
    const quota = apiError(429, {
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3600s' }]
    })
    const operation = vi.fn(failingTimes([quota], 'ok'))
    await expect(withRetries(operation, { sleep: fakeSleep, random: () => 0 })).rejects.toBe(quota)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('retries a timed-out request only once', async () => {
    const { sleep: fakeSleep } = instantSleep()
    const operation = vi.fn(failingTimes([abortError(), abortError(), abortError()], 'ok'))
    await expect(withRetries(operation, { sleep: fakeSleep, random: () => 0 })).rejects.toThrow()
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('respects maxAttempts and reports retries', async () => {
    const { sleep: fakeSleep } = instantSleep()
    const onRetry = vi.fn()
    const operation = vi.fn(failingTimes([networkError(), networkError()], 'ok'))
    await expect(
      withRetries(operation, { sleep: fakeSleep, random: () => 0, maxAttempts: 2, onRetry })
    ).rejects.toThrow('fetch failed')
    expect(operation).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry.mock.calls[0][0].kind).toBe('network')
  })

  it('stops when cancelled during the backoff', async () => {
    const controller = new AbortController()
    const operation = vi.fn(async () => {
      throw networkError()
    })
    const pending = withRetries(operation, { sleep, random: () => 0, signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    const error = await pending.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AnalyzerError)
    expect((error as AnalyzerError).code).toBe('cancelled')
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('does not start when already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const operation = vi.fn(async () => 'ok')
    await expect(
      withRetries(operation, { sleep, random: () => 0, signal: controller.signal })
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(operation).not.toHaveBeenCalled()
  })
})

describe('retryDelayMs', () => {
  const network = classifyError(networkError())
  it('uses equal jitter on an exponential base, capped at a minute', () => {
    expect(retryDelayMs(network, 1, () => 0)).toBe(1_000)
    expect(retryDelayMs(network, 1, () => 1)).toBe(2_000)
    expect(retryDelayMs(network, 3, () => 0)).toBe(4_000)
    expect(retryDelayMs(network, 10, () => 1)).toBe(60_000)
  })

  it('uses a longer base for per-minute quotas', () => {
    const quota = classifyError(apiError(429))
    expect(retryDelayMs(quota, 1, () => 0)).toBe(5_000)
    expect(retryDelayMs(quota, 2, () => 0)).toBe(10_000)
  })
})

describe('sleep', () => {
  it('waits and resolves', async () => {
    const started = Date.now()
    await sleep(20)
    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
  })

  it('rejects with a cancellation when aborted', async () => {
    const controller = new AbortController()
    const pending = sleep(10_000, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled', message: 'Cancelled.' })
    const aborted = AbortSignal.abort()
    await expect(sleep(10, aborted)).rejects.toMatchObject({ code: 'cancelled' })
  })
})

describe('withCallSignal', () => {
  it('links the parent signal and removes its listener afterwards', async () => {
    const parent = new AbortController()
    const remove = vi.spyOn(parent.signal, 'removeEventListener')
    let child: AbortSignal | undefined
    await withCallSignal(parent.signal, async (signal) => {
      child = signal
      expect(signal).not.toBe(parent.signal)
      parent.abort()
      expect(signal?.aborted).toBe(true)
    })
    expect(child?.aborted).toBe(true)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('passes no signal when there is no parent', async () => {
    await withCallSignal(undefined, async (signal) => {
      expect(signal).toBeUndefined()
    })
  })
})

describe('untilAborted', () => {
  it('resolves like the promise', async () => {
    await expect(untilAborted(Promise.resolve(3), new AbortController().signal)).resolves.toBe(3)
    await expect(untilAborted(Promise.reject(new Error('x')), undefined)).rejects.toThrow('x')
  })

  it('rejects as soon as the signal aborts', async () => {
    const controller = new AbortController()
    const never = new Promise<number>(() => undefined)
    const pending = untilAborted(never, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  })
})
