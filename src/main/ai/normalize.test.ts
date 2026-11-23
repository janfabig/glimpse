import { describe, expect, it } from 'vitest'
import { ContentProblem } from './errors'
import {
  fitAroundPeak,
  normalizeResponse,
  parseJsonPayload,
  parseStamp,
  pickBetterReport,
  type NormalizeContext,
  type NormalizeReport
} from './normalize'

const ctx: NormalizeContext = { durationSec: 60, maxMoments: 10 }

function moment(start: unknown, end: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    start,
    peak: undefined,
    end,
    title: 'Title',
    reason: 'Reason.',
    score: 7,
    ...extra
  }
}

function normalize(
  moments: unknown[],
  extra: Record<string, unknown> = {},
  context = ctx
): NormalizeReport {
  return normalizeResponse({ videoEndsAt: '01:00', moments, ...extra }, context)
}

function spans(report: NormalizeReport): [number, number][] {
  return report.moments.map((m) => [m.start, m.end])
}

describe('parseStamp', () => {
  it.each([
    ['01:05', 65],
    ['1:05', 65],
    ['00:00', 0],
    ['75', 75],
    ['12.5s', 12.5],
    ['01:07.5', 67.5],
    ['1:02:03', 3723],
    ['[01:05]', 65],
    [' 00:42 ', 42],
    ['0:65', 65],
    ['00:65', 65],
    ['0:01:75', 135]
  ])('parses %j as %d s', (input, expected) => {
    expect(parseStamp(input)).toBe(expected)
  })

  it('accepts numbers', () => {
    expect(parseStamp(42)).toBe(42)
    expect(parseStamp(0)).toBe(0)
  })

  it('reads M:SS overflow as a total, preferring the reading inside the video', () => {
    expect(parseStamp('1:65', 300)).toBe(125)
    expect(parseStamp('1:65', 100)).toBe(65)
  })

  // the seconds field alone is a total only when the minutes field agrees with it
  it.each([
    ['04:62', 300, 302],
    ['29:75', 1800, 1815]
  ])('reads %j in a %d s video as %d s (minutes rule out the seconds alone)', (input, d, s) => {
    expect(parseStamp(input, d)).toBe(s)
  })

  // a sum up to a few seconds past the end is an overrun at the end, also when the minutes match
  it.each([
    ['01:62', 120, 122],
    ['01:60', 118, 120]
  ])('reads %j in a %d s video as %d s (an overrun at the end)', (input, d, s) => {
    expect(parseStamp(input, d)).toBe(s)
  })

  it.each([[''], ['abc'], ['01:05-01:10'], ['-5'], ['1:2:3:4']])('rejects %j', (input) => {
    expect(parseStamp(input)).toBeNull()
  })

  it.each([[null], [undefined], [{}], [[]], [Number.NaN], [-1], [Number.POSITIVE_INFINITY]])(
    'rejects %j',
    (input) => {
      expect(parseStamp(input)).toBeNull()
    }
  )
})

describe('fitAroundPeak', () => {
  const limits = { min: 2, max: 8 }
  const video = { start: 0, end: 60 }

  it('keeps spans that already fit', () => {
    expect(fitAroundPeak({ start: 10, end: 15 }, 12, limits, video)).toEqual({ start: 10, end: 15 })
  })

  it('expands a short span to the minimum and keeps all of it', () => {
    const fitted = fitAroundPeak({ start: 10, end: 11 }, 10.5, limits, video)
    expect(fitted.start).toBeCloseTo(9.7)
    expect(fitted.end).toBeCloseTo(11.7)
  })

  it('cuts a long span to the maximum with the peak at ~40 %', () => {
    const fitted = fitAroundPeak({ start: 10, end: 30 }, 25, limits, video)
    expect(fitted.start).toBeCloseTo(21.8)
    expect(fitted.end).toBeCloseTo(29.8)
  })

  it('stays inside the original span when the peak sits at its edge', () => {
    expect(fitAroundPeak({ start: 10, end: 30 }, 11, limits, video)).toEqual({ start: 10, end: 18 })
    expect(fitAroundPeak({ start: 10, end: 30 }, 30, limits, video)).toEqual({ start: 22, end: 30 })
  })

  it('shifts expanded spans back inside the bounds', () => {
    expect(fitAroundPeak({ start: 0, end: 0.5 }, 0.2, limits, video)).toEqual({ start: 0, end: 2 })
    expect(fitAroundPeak({ start: 59.5, end: 60 }, 59.8, limits, video)).toEqual({
      start: 58,
      end: 60
    })
  })

  it('returns the whole bounds when they are shorter than the minimum', () => {
    expect(fitAroundPeak({ start: 1, end: 1.5 }, 1.2, limits, { start: 0, end: 1.8 })).toEqual({
      start: 0,
      end: 1.8
    })
  })
})

describe('parseJsonPayload', () => {
  it('parses bare JSON', () => {
    expect(parseJsonPayload('{"moments":[]}')).toEqual({ moments: [] })
  })

  it('strips a ```json fence', () => {
    expect(parseJsonPayload('```json\n{"moments":[1]}\n```')).toEqual({ moments: [1] })
    expect(parseJsonPayload('```\n[1,2]\n```')).toEqual([1, 2])
  })

  it('finds JSON surrounded by prose', () => {
    expect(parseJsonPayload('Here is the result:\n{"moments":[]}\nHave fun!')).toEqual({
      moments: []
    })
  })

  it.each([['no JSON'], ['{"moments": [{"start": "00:01"'], ['']])(
    'reports %j as a format problem',
    (text) => {
      expect(() => parseJsonPayload(text)).toThrow(ContentProblem)
      try {
        parseJsonPayload(text)
      } catch (err) {
        expect((err as ContentProblem).kind).toBe('format')
      }
    }
  )
})

describe('normalizeResponse', () => {
  it('passes a clean answer through, sorted by start, without fields nobody asked for', () => {
    const report = normalize(
      [
        moment('00:20', '00:25', { peak: '00:22', title: 'Crowd cheers', score: 7 }),
        moment('00:05', '00:10', { peak: '00:07', title: 'Drop', score: 9, tags: ['Drop'] })
      ],
      { summary: 'Short.' }
    )
    expect(report.moments).toEqual([
      { start: 5, end: 10, title: 'Drop', reason: 'Reason.', score: 9 },
      { start: 20, end: 25, title: 'Crowd cheers', reason: 'Reason.', score: 7 }
    ])
    expect(report).not.toHaveProperty('summary')
    expect(report).toMatchObject({
      candidateCount: 2,
      invalidCount: 0,
      overrunCount: 0,
      videoEndsAt: 60,
      retryReason: null
    })
  })

  it('reads malformed stamps such as 0:65', () => {
    const report = normalize(
      [moment('0:65', '0:70')],
      { videoEndsAt: '2:00' },
      { ...ctx, durationSec: 120 }
    )
    expect(spans(report)).toEqual([[65, 70]])
  })

  it('accepts plain seconds as numbers and strings', () => {
    expect(spans(normalize([moment(10, '14.5')]))).toEqual([[10, 14.5]])
  })

  it('swaps reversed start and end', () => {
    expect(spans(normalize([moment('00:30', '00:25')]))).toEqual([[25, 30]])
  })

  describe('stamps past the end', () => {
    it('clamps an overrunning end', () => {
      const report = normalize([moment('00:55', '01:10'), moment('00:10', '00:15')])
      expect(spans(report)).toEqual([
        [10, 15],
        [55, 60]
      ])
      expect(report.overrunCount).toBe(1)
      expect(report.retryReason).toBeNull()
    })

    it('drops clips starting at or after the end', () => {
      const report = normalize([
        moment('01:00', '01:04'),
        moment('01:05', '01:08'),
        moment('00:10', '00:15')
      ])
      expect(spans(report)).toEqual([[10, 15]])
      expect(report.invalidCount).toBe(2)
    })

    it('asks for a retry when videoEndsAt disagrees and stamps overrun', () => {
      const report = normalize([moment('00:55', '01:10'), moment('00:10', '00:15')], {
        videoEndsAt: '01:10'
      })
      expect(report.retryReason).toBe('ends-at-mismatch')
      expect(report.videoEndsAt).toBe(70)
    })

    it('treats a missing videoEndsAt as a mismatch when stamps overrun', () => {
      const report = normalize([moment('00:55', '01:10')], { videoEndsAt: undefined })
      expect(report.retryReason).toBe('ends-at-mismatch')
      expect(report.videoEndsAt).toBeNull()
    })

    it('ignores a videoEndsAt mismatch without overruns', () => {
      expect(normalize([moment('00:10', '00:15')], { videoEndsAt: '03:00' }).retryReason).toBeNull()
    })

    it('keeps a moment with an overflowing end stamp (04:62) at the end of the video', () => {
      const report = normalize(
        [moment('04:55', '04:62', { peak: '04:58', title: 'Finale' })],
        { videoEndsAt: '05:00' },
        { ...ctx, durationSec: 300 }
      )
      expect(report.moments.map((m) => [m.title, m.start, m.end])).toEqual([['Finale', 295, 300]])
      // 302 s is a real overrun, but videoEndsAt matches the video: no retry
      expect(report.overrunCount).toBe(1)
      expect(report.retryReason).toBeNull()
    })

    it('tolerates one second of rounding at the end', () => {
      const report = normalize([moment('00:55', '01:01')])
      expect(report.overrunCount).toBe(0)
      expect(spans(report)).toEqual([[55, 60]])
    })
  })

  describe('clip length (1 to 30 seconds)', () => {
    it('keeps every length inside the range as Gemini chose it', () => {
      const report = normalize([moment('00:02', '00:03'), moment('00:10', '00:40')])
      expect(spans(report)).toEqual([
        [2, 3],
        [10, 40]
      ])
    })

    it('expands too short clips around the peak', () => {
      const report = normalize([moment('00:10', '00:10.4', { peak: '00:10.2' })])
      expect(spans(report)).toEqual([[9.8, 10.8]])
    })

    it('cuts too long clips around the peak', () => {
      const report = normalize([moment('00:05', '00:50', { peak: '00:30' })])
      expect(spans(report)).toEqual([[18, 48]])
    })

    it('expands a zero-length clip instead of dropping it', () => {
      const report = normalize([moment('00:10', '00:10')])
      expect(spans(report)).toEqual([[9.6, 10.6]])
      expect(report.invalidCount).toBe(0)
    })

    it('uses the whole video when it is shorter than the minimum', () => {
      const report = normalize(
        [moment(0, 0.3)],
        { videoEndsAt: '00:01' },
        { ...ctx, durationSec: 0.6 }
      )
      expect(spans(report)).toEqual([[0, 0.6]])
    })
  })

  describe('peak', () => {
    it('centres a peak outside the clip', () => {
      // centre 27.5 → 30 s clip with the peak at 40 %
      const report = normalize([moment('00:05', '00:50', { peak: '00:58' })])
      expect(spans(report)).toEqual([[15.5, 45.5]])
    })

    it('centres a missing or broken peak', () => {
      expect(spans(normalize([moment('00:05', '00:50', { peak: 'soon' })]))).toEqual([[15.5, 45.5]])
      expect(spans(normalize([moment('00:05', '00:50')]))).toEqual([[15.5, 45.5]])
    })
  })

  describe('overlaps', () => {
    it('trims the weaker clip to the gap after the stronger one', () => {
      const report = normalize([
        moment('00:14', '00:20', { peak: '00:18', score: 6, title: 'B' }),
        moment('00:10', '00:16', { peak: '00:12', score: 9, title: 'A' })
      ])
      expect(report.moments.map((m) => [m.title, m.start, m.end])).toEqual([
        ['A', 10, 16],
        ['B', 16, 20]
      ])
    })

    it('drops the weaker clip when its peak lies inside the stronger one', () => {
      const report = normalize([
        moment('00:10', '00:16', { peak: '00:12', score: 9 }),
        moment('00:14', '00:20', { peak: '00:15', score: 6 })
      ])
      expect(spans(report)).toEqual([[10, 16]])
    })

    it('drops the weaker clip when the free gap is shorter than the minimum', () => {
      const report = normalize([
        moment('00:10', '00:16', { peak: '00:12', score: 9 }),
        moment('00:12', '00:19', { peak: '00:16.2', score: 5 }),
        moment('00:16.5', '00:25', { peak: '00:22', score: 8 })
      ])
      expect(spans(report)).toEqual([
        [10, 16],
        [16.5, 25]
      ])
    })

    it('re-fits a trimmed clip to the minimum length inside the gap', () => {
      const report = normalize([
        moment('00:10', '00:16', { peak: '00:12', score: 9 }),
        moment('00:15', '00:16.5', { peak: '00:16.3', score: 6 })
      ])
      expect(spans(report)).toEqual([
        [10, 16],
        [16, 17]
      ])
    })

    it('prefers the earlier clip on equal scores', () => {
      const report = normalize([
        moment('00:12', '00:18', { peak: '00:13', score: 7, title: 'later' }),
        moment('00:10', '00:16', { peak: '00:14', score: 7, title: 'earlier' })
      ])
      expect(report.moments.map((m) => m.title)).toEqual(['earlier'])
    })

    it('keeps clips that only touch', () => {
      const report = normalize([
        moment('00:10', '00:15', { score: 9 }),
        moment('00:15', '00:20', { peak: '00:15' })
      ])
      expect(spans(report)).toEqual([
        [10, 15],
        [15, 20]
      ])
    })

    it('keeps one of several duplicates', () => {
      const duplicate = moment('00:10', '00:15', { peak: '00:10', score: 8 })
      const report = normalize([duplicate, duplicate, duplicate])
      expect(spans(report)).toEqual([[10, 15]])
      expect(report.invalidCount).toBe(0)
    })
  })

  describe('lead-out for whole-second end stamps (≤ 1 fps)', () => {
    // the field report: a punchline and laugh ending at 72.6 s come back as end 01:12
    const oneFps: NormalizeContext = { durationSec: 299.97, maxMoments: 15, fps: 1 }
    const answer = (moments: unknown[], context = oneFps): NormalizeReport =>
      normalizeResponse({ videoEndsAt: '04:59', moments }, context)

    it('pads each end by 0.8 s', () => {
      expect(spans(answer([moment('01:05', '01:12')]))).toEqual([[65, 72.8]])
    })

    it('pads at lower rates too, but not above 1 fps', () => {
      expect(spans(answer([moment('01:05', '01:12')], { ...oneFps, fps: 0.5 }))).toEqual([
        [65, 72.8]
      ])
      expect(spans(answer([moment('01:05', '01:12')], { ...oneFps, fps: 2 }))).toEqual([[65, 72]])
      // without a sampling rate (the fake analyzer) the stamps are taken as exact
      const exact = { ...oneFps, fps: undefined }
      expect(spans(answer([moment('01:05', '01:12')], exact))).toEqual([[65, 72]])
    })

    it('never pads past the end of the video', () => {
      expect(spans(answer([moment('04:55', '04:59.5')]))).toEqual([[295, 299.97]])
    })

    it('never pads into the next moment', () => {
      const report = answer([
        moment('00:10', '00:15', { score: 6 }),
        moment('00:15.5', '00:20', { score: 9 }),
        moment('00:30', '00:35', { score: 7 })
      ])
      expect(spans(report)).toEqual([
        [10, 15.5],
        [15.5, 20.8],
        [30, 35.8]
      ])
    })

    it('never pads a clip past the longest clip length', () => {
      const report = answer([moment('00:10', '00:40'), moment('01:00', '01:29.6')])
      expect(spans(report)).toEqual([
        [10, 40],
        [60, 90]
      ])
    })
  })

  it('asks for a retry when the list is empty (the schema requires a moment)', () => {
    const report = normalize([])
    expect(report.moments).toEqual([])
    expect(report.candidateCount).toBe(0)
    expect(report.retryReason).toBe('no-moments')
  })

  it('fills in missing optional fields', () => {
    const report = normalizeResponse({ moments: [{ start: '00:10', end: '00:14' }] }, ctx)
    expect(report.moments).toEqual([
      { start: 10, end: 14, title: 'Moment at 0:10', reason: '', score: 5 }
    ])
    expect(report.videoEndsAt).toBeNull()
  })

  it('counts candidates without start or end as invalid', () => {
    const report = normalize([{ end: '00:10' }, { start: '00:10' }, moment('00:20', '00:24')])
    expect(report.invalidCount).toBe(2)
    expect(spans(report)).toEqual([[20, 24]])
  })

  it('copes with wrong types', () => {
    const report = normalize([
      'not an object',
      null,
      42,
      moment('00:01', '00:04', { score: '8', title: 42 }),
      moment('00:10', '00:14', { score: 12.7 }),
      moment('00:20', '00:24', { score: 0, reason: { text: 'x' } }),
      moment('00:30', '00:34', { score: -3 }),
      moment('00:40', '00:44', { score: 'high' }),
      moment('00:50', '00:54', { score: null })
    ])
    expect(report.invalidCount).toBe(3)
    expect(report.moments.map((m) => m.score)).toEqual([8, 10, 1, 1, 5, 5])
    expect(report.moments[0].title).toBe('Moment at 0:01')
    expect(report.moments[2].reason).toBe('')
  })

  it('cleans up texts', () => {
    const long = 'A very long title that goes far beyond the allowed length and has to be shortened'
    const report = normalize([
      moment('00:01', '00:04', {
        title: '  “Drop   with light show”  ',
        reason: ' The  drop\n hits. '
      }),
      moment('00:10', '00:14', { title: long })
    ])
    expect(report.moments[0].title).toBe('Drop with light show')
    expect(report.moments[0].reason).toBe('The drop hits.')
    expect(report.moments[1].title.length).toBeLessThanOrEqual(60)
    expect(report.moments[1].title.endsWith('…')).toBe(true)
  })

  it('keeps only the best moments when there are too many', () => {
    const scores = [3, 9, 5, 8, 1]
    const report = normalize(
      scores.map((score, i) => moment(i * 10, i * 10 + 4, { score })),
      {},
      { ...ctx, maxMoments: 3 }
    )
    expect(report.moments.map((m) => [m.start, m.score])).toEqual([
      [10, 9],
      [20, 5],
      [30, 8]
    ])
  })

  it('asks for a retry only when more than 30 % of the candidates are invalid', () => {
    const valid = (n: number): unknown[] =>
      Array.from({ length: n }, (_, i) => moment(i * 8, i * 8 + 4))
    const broken = (n: number): unknown[] => Array.from({ length: n }, () => moment('abc', '00:05'))
    expect(normalize([...valid(7), ...broken(3)]).retryReason).toBeNull()
    expect(normalize([...valid(6), ...broken(4)]).retryReason).toBe('invalid-candidates')
    expect(normalize(broken(2)).retryReason).toBe('invalid-candidates')
  })

  it('accepts a bare array of moments', () => {
    const report = normalizeResponse([moment('00:10', '00:14')], ctx)
    expect(spans(report)).toEqual([[10, 14]])
  })

  it.each([['text'], [null], [{}], [{ moments: 'none' }], [{ segments: [] }]])(
    'reports %j as a format problem',
    (payload) => {
      expect(() => normalizeResponse(payload, ctx)).toThrow(ContentProblem)
    }
  )

  it('always yields sorted, non-overlapping clips of valid length inside the video', () => {
    let seed = 7
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    const stamp = (max: number): unknown => {
      const value = random() * max
      const pick = random()
      if (pick < 0.1) return 'broken'
      if (pick < 0.4) return Math.round(value * 10) / 10
      return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`
    }
    for (let run = 0; run < 300; run++) {
      const duration = 5 + random() * 300
      // 1 fps like the app's requests: the lead-out is part of what must stay in range
      const context: NormalizeContext = { durationSec: duration, maxMoments: 15, fps: 1 }
      const candidates = Array.from({ length: Math.floor(random() * 20) }, () =>
        moment(stamp(duration * 1.1), stamp(duration * 1.1), {
          peak: stamp(duration),
          score: Math.round(random() * 14) - 2
        })
      )
      const { moments } = normalizeResponse({ moments: candidates }, context)
      moments.forEach((m, i) => {
        expect(m.start).toBeGreaterThanOrEqual(0)
        expect(m.end).toBeLessThanOrEqual(duration)
        expect(m.end - m.start).toBeGreaterThanOrEqual(1 - 0.011)
        expect(m.end - m.start).toBeLessThanOrEqual(30 + 0.011)
        expect(Number.isInteger(m.score) && m.score >= 1 && m.score <= 10).toBe(true)
        if (i > 0) expect(m.start).toBeGreaterThanOrEqual(moments[i - 1].end)
      })
    }
  })
})

describe('pickBetterReport', () => {
  const report = (count: number, retryReason: NormalizeReport['retryReason']): NormalizeReport => ({
    moments: Array.from({ length: count }, (_, i) => ({
      start: i * 10,
      end: i * 10 + 4,
      title: 't',
      reason: '',
      score: 5
    })),
    candidateCount: count,
    invalidCount: 0,
    overrunCount: 0,
    videoEndsAt: null,
    retryReason
  })

  it('prefers an answer with moments over one without', () => {
    const imperfect = report(1, 'invalid-candidates')
    const empty = report(0, null)
    expect(pickBetterReport(imperfect, empty)).toBe(imperfect)
    expect(pickBetterReport(empty, imperfect)).toBe(imperfect)
  })

  it('prefers the answer without problems', () => {
    const clean = report(1, null)
    expect(pickBetterReport(report(5, 'invalid-candidates'), clean)).toBe(clean)
    expect(pickBetterReport(clean, report(5, 'ends-at-mismatch'))).toBe(clean)
  })

  it('then prefers more moments, ties going to the newer answer', () => {
    const first = report(3, 'invalid-candidates')
    const second = report(2, 'invalid-candidates')
    expect(pickBetterReport(first, second)).toBe(first)
    const third = report(3, 'ends-at-mismatch')
    expect(pickBetterReport(first, third)).toBe(third)
  })
})
