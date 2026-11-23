import { describe, expect, it } from 'vitest'
import type { ProgressSample } from './progress'
import {
  createProgressParser,
  outTimeFromFields,
  parseClockTime,
  progressFraction
} from './progress'

describe('parseClockTime', () => {
  it('parses ffmpeg clock values', () => {
    expect(parseClockTime('00:00:04.000000')).toBe(4)
    expect(parseClockTime('01:02:03.5')).toBeCloseTo(3723.5)
    expect(parseClockTime('-00:00:00.021333')).toBeCloseTo(-0.021333)
  })

  it('rejects anything else', () => {
    expect(parseClockTime('N/A')).toBeNull()
    expect(parseClockTime('12.5')).toBeNull()
  })
})

describe('outTimeFromFields', () => {
  it('prefers out_time_us and treats out_time_ms as microseconds', () => {
    expect(outTimeFromFields(new Map([['out_time_us', '2500000']]))).toBe(2.5)
    expect(outTimeFromFields(new Map([['out_time_ms', '2500000']]))).toBe(2.5)
    expect(
      outTimeFromFields(
        new Map([
          ['out_time_us', '1000000'],
          ['out_time', '00:00:09.000000']
        ])
      )
    ).toBe(1)
  })

  it('falls back to out_time and ignores N/A', () => {
    expect(
      outTimeFromFields(
        new Map([
          ['out_time_us', 'N/A'],
          ['out_time', '00:00:01.250000']
        ])
      )
    ).toBe(1.25)
    expect(outTimeFromFields(new Map([['out_time_us', 'N/A']]))).toBeNull()
  })
})

describe('createProgressParser', () => {
  it('emits one sample per block, also across chunk boundaries', () => {
    const samples: ProgressSample[] = []
    const feed = createProgressParser((s) => samples.push(s))
    feed('frame=10\nout_time_us=500000\nout_time_ms=500000\nprog')
    feed('ress=continue\nframe=20\nout_time_us=N/A\nprogress=continue\n')
    feed('out_time_us=1000000\r\nprogress=end\r\n')
    expect(samples).toEqual([
      { outTimeSec: 0.5, done: false },
      { outTimeSec: null, done: false },
      { outTimeSec: 1, done: true }
    ])
  })
})

describe('progressFraction', () => {
  it('clamps to 0..1', () => {
    expect(progressFraction(5, 10)).toBe(0.5)
    expect(progressFraction(12, 10)).toBe(1)
    expect(progressFraction(-0.02, 10)).toBe(0)
  })

  it('is indeterminate without a usable duration or time', () => {
    expect(progressFraction(5, undefined)).toBe(-1)
    expect(progressFraction(5, 0)).toBe(-1)
    expect(progressFraction(null, 10)).toBe(-1)
  })
})
