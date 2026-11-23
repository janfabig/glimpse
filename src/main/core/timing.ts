// Time helpers: monotonic timestamps and a trailing-edge throttle with an injectable clock.

export interface Clock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/**
 * ISO timestamp for `now` that is strictly later than `previous`. The renderer drops project
 * updates whose `updatedAt` is older than what it has, so this must never step back.
 */
export function nextTimestamp(previous: string | undefined, now: Date): string {
  const prev = previous ? Date.parse(previous) : Number.NaN
  const time = Number.isFinite(prev) && now.getTime() <= prev ? prev + 1 : now.getTime()
  return new Date(time).toISOString()
}

/** Delivers at most one value per interval; the latest pushed value is always delivered. */
export class Throttle<T> {
  private readonly intervalMs: number
  private readonly deliver: (value: T) => void
  private readonly clock: Clock
  private lastSent = Number.NEGATIVE_INFINITY
  private timer: unknown = null
  private pending: { value: T } | null = null

  constructor(intervalMs: number, deliver: (value: T) => void, clock: Clock = systemClock) {
    this.intervalMs = intervalMs
    this.deliver = deliver
    this.clock = clock
  }

  push(value: T): void {
    if (this.timer !== null) {
      this.pending = { value }
      return
    }
    const wait = this.lastSent + this.intervalMs - this.clock.now()
    if (wait <= 0) {
      this.send(value)
      return
    }
    this.pending = { value }
    this.timer = this.clock.setTimeout(() => this.fire(), wait)
  }

  /** sends `value` right away and drops whatever was pending */
  pushNow(value: T): void {
    this.cancel()
    this.send(value)
  }

  /** sends the pending value right away (nothing pending: nothing happens) */
  flush(): void {
    const pending = this.pending
    if (!pending) return
    this.cancel()
    this.send(pending.value)
  }

  /** drops a pending value without delivering it */
  cancel(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
    this.pending = null
  }

  private fire(): void {
    this.timer = null
    const pending = this.pending
    this.pending = null
    if (pending) this.send(pending.value)
  }

  private send(value: T): void {
    this.lastSent = this.clock.now()
    this.deliver(value)
  }
}
