import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTimestamp, Throttle } from './timing'

describe('nextTimestamp', () => {
  it('uses the current time when it is later', () => {
    expect(nextTimestamp('2026-07-12T20:00:00.000Z', new Date('2026-07-12T20:00:01.000Z'))).toBe(
      '2026-07-12T20:00:01.000Z'
    )
    expect(nextTimestamp(undefined, new Date('2026-07-12T20:00:01.000Z'))).toBe(
      '2026-07-12T20:00:01.000Z'
    )
  })

  it('never steps back, even when the clock does', () => {
    expect(nextTimestamp('2026-07-12T20:00:05.000Z', new Date('2026-07-12T20:00:01.000Z'))).toBe(
      '2026-07-12T20:00:05.001Z'
    )
    expect(nextTimestamp('2026-07-12T20:00:05.000Z', new Date('2026-07-12T20:00:05.000Z'))).toBe(
      '2026-07-12T20:00:05.001Z'
    )
  })
})

describe('Throttle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('delivers the leading value, then the latest one per interval', () => {
    const seen: number[] = []
    const throttle = new Throttle<number>(100, (v) => seen.push(v))
    throttle.push(1)
    throttle.push(2)
    throttle.push(3)
    expect(seen).toEqual([1])
    vi.advanceTimersByTime(100)
    expect(seen).toEqual([1, 3])
    vi.advanceTimersByTime(500)
    throttle.push(4)
    expect(seen).toEqual([1, 3, 4])
  })

  it('flush delivers the pending value right away and restarts the interval', () => {
    const seen: number[] = []
    const throttle = new Throttle<number>(100, (v) => seen.push(v))
    throttle.flush()
    expect(seen).toEqual([])
    throttle.push(1)
    throttle.push(2)
    throttle.flush()
    expect(seen).toEqual([1, 2])
    // nothing is delivered twice, and the next value waits for a full interval again
    vi.advanceTimersByTime(300)
    expect(seen).toEqual([1, 2])
    throttle.push(3)
    throttle.push(4)
    expect(seen).toEqual([1, 2, 3])
    vi.advanceTimersByTime(100)
    expect(seen).toEqual([1, 2, 3, 4])
  })

  it('pushNow bypasses the interval and drops the pending value; cancel drops it too', () => {
    const seen: number[] = []
    const throttle = new Throttle<number>(100, (v) => seen.push(v))
    throttle.push(1)
    throttle.push(2)
    throttle.pushNow(9)
    vi.advanceTimersByTime(300)
    expect(seen).toEqual([1, 9])
    throttle.push(3)
    throttle.push(4)
    throttle.cancel()
    vi.advanceTimersByTime(300)
    expect(seen).toEqual([1, 9, 3])
  })
})
