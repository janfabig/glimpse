import { DEFAULT_BRIEF, DEFAULT_EXPORT_SETTINGS } from '@shared/presets'
import type { Moment, Project } from '@shared/types'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { applyAutoSelect, autoSelect, effectiveLength, transitionOverlap } from './selection'
import { makeMoment, makeProject, makeVideo, selectedIds } from './testing/fixtures'

function project(options: {
  target: number | null
  moments: Moment[]
  videos?: string[]
  crossfade?: boolean
}): Project {
  return makeProject({
    videos: (options.videos ?? ['v1', 'v2', 'v3']).map((id) => makeVideo({ id, durationSec: 120 })),
    brief: { ...DEFAULT_BRIEF, targetDurationSec: options.target },
    exportSettings: {
      ...DEFAULT_EXPORT_SETTINGS,
      transition: options.crossfade ? 'crossfade' : 'cut'
    },
    moments: options.moments
  })
}

/** AI moment starting at `start` with the given length and score */
function ai(id: string, videoId: string, start: number, length: number, score: number): Moment {
  return makeMoment({ id, videoId, start, end: start + length, score })
}

const sorted = (values: string[]): string[] => [...values].sort()

describe('effective length', () => {
  it('subtracts one overlap per transition', () => {
    const clips = [
      { start: 0, end: 8 },
      { start: 0, end: 6 },
      { start: 0, end: 10 }
    ]
    expect(effectiveLength(clips, 0)).toBe(24)
    expect(effectiveLength(clips, 0.5)).toBe(23)
    expect(effectiveLength(clips.slice(0, 1), 0.5)).toBe(8)
    expect(effectiveLength([], 0.5)).toBe(0)
  })

  it('only overlaps with crossfades', () => {
    expect(transitionOverlap(project({ target: 30, moments: [], crossfade: true }))).toBe(0.4)
    expect(transitionOverlap(project({ target: 30, moments: [] }))).toBe(0)
  })
})

describe('autoSelect without target', () => {
  it('takes every moment with score ≥ 7, in chronological order', () => {
    const result = autoSelect(
      project({
        target: null,
        moments: [
          ai('a', 'v2', 10, 4, 8),
          ai('b', 'v1', 50, 4, 5),
          ai('c', 'v1', 20, 6, 9),
          ai('d', 'v1', 5, 3, 7)
        ]
      })
    )
    expect(result.map((m) => m.id)).toEqual(['d', 'c', 'b', 'a'])
    expect(selectedIds(result)).toEqual(['d', 'c', 'a'])
  })

  it('falls back to the three best when nothing is strong (ties → shorter)', () => {
    const result = autoSelect(
      project({
        target: null,
        moments: [
          ai('e1', 'v1', 0, 4, 6),
          ai('e2', 'v1', 10, 8, 6),
          ai('e3', 'v1', 20, 3, 5),
          ai('e4', 'v1', 30, 2, 5),
          ai('e5', 'v1', 40, 2, 2)
        ]
      })
    )
    expect(selectedIds(result)).toEqual(['e1', 'e2', 'e4'])
  })

  it('handles no candidates', () => {
    expect(autoSelect(project({ target: null, moments: [] }))).toEqual([])
  })
})

describe('autoSelect with target', () => {
  // T = 30 → tolerance max(2, 2.4) = 2.4 → a list fits up to 32.4 s
  const twoVideos = (): Moment[] => [
    ai('a', 'v1', 0, 8, 9),
    ai('b', 'v1', 10, 6, 8),
    ai('c', 'v1', 20, 7, 5),
    ai('d', 'v2', 0, 10, 7),
    ai('e', 'v2', 12, 3, 6)
  ]

  it('picks one strong moment per video first, then fills by score within the tolerance', () => {
    const result = autoSelect(project({ target: 30, videos: ['v1', 'v2'], moments: twoVideos() }))
    // diversity: a (v1), d (v2) = 18 s · fill: b → 24, e → 27, c → 34 > 32.4 ✗
    expect(selectedIds(result)).toEqual(['a', 'b', 'd', 'e'])
    expect(result.every((m) => m.start === m.aiStart && m.end === m.aiEnd)).toBe(true)
  })

  it('accounts for crossfade overlaps', () => {
    // c is 6.5 s here: 33.5 s of clips are too long with hard cuts (> 32.4) …
    const moments = twoVideos().map((m) => (m.id === 'c' ? ai('c', 'v1', 20, 6.5, 5) : m))
    const cut = autoSelect(project({ target: 30, videos: ['v1', 'v2'], moments }))
    expect(selectedIds(cut)).toEqual(['a', 'b', 'd', 'e'])
    // … and fit with the four 0.4 s overlaps: 33.5 − 4 · 0.4 = 31.9 ≤ 32.4
    const result = autoSelect(
      project({ target: 30, videos: ['v1', 'v2'], moments, crossfade: true })
    )
    expect(selectedIds(result)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(
      effectiveLength(
        result.filter((m) => m.selected),
        0.4
      )
    ).toBeCloseTo(31.9, 6)
  })

  it('resets previous flags and returns chronological order without touching the input', () => {
    const moments = [...twoVideos()].reverse().map((m) => ({ ...m, selected: m.id === 'c' }))
    const input = project({ target: 30, videos: ['v1', 'v2'], moments })
    const snapshot = structuredClone(input)
    const result = autoSelect(input)
    expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(result.find((m) => m.id === 'c')?.selected).toBe(false)
    expect(input).toEqual(snapshot)
  })

  it('skips a diversity pick that does not fit', () => {
    // v1's a fills 25 s; v2's best clip b (10 s) is too long for the rest, its weaker c fits
    const result = autoSelect(
      project({
        target: 30,
        videos: ['v1', 'v2'],
        moments: [ai('a', 'v1', 60, 25, 9), ai('b', 'v2', 0, 10, 9), ai('c', 'v2', 20, 5, 6)]
      })
    )
    expect(selectedIds(result)).toEqual(['a', 'c'])
  })

  it('gives a tight target to the best videos, not to the first ones', () => {
    // T = 60 (fits up to 64.8): three 20 s clips fill it – v4 holds the best clip of the project
    const result = autoSelect(
      project({
        target: 60,
        videos: ['v1', 'v2', 'v3', 'v4'],
        moments: [
          ai('a', 'v1', 0, 20, 6),
          ai('b', 'v2', 0, 20, 6),
          ai('c', 'v3', 0, 20, 6),
          ai('d', 'v4', 0, 20, 10)
        ]
      })
    )
    // equal scores keep the video order: v3 is the one left out
    expect(selectedIds(result)).toEqual(['a', 'b', 'd'])
  })

  it('prefers the shorter moment on equal scores', () => {
    // T = 10 (fits up to 12): y (4 s) wins the diversity pick, x is then trimmed to fill the gap
    const result = autoSelect(
      project({
        target: 10,
        videos: ['v1'],
        moments: [ai('x', 'v1', 0, 10, 8), ai('y', 'v1', 20, 4, 8)]
      })
    )
    expect(result.find((m) => m.id === 'y')).toMatchObject({ selected: true, start: 20, end: 24 })
    expect(result.find((m) => m.id === 'x')).toMatchObject({
      selected: true,
      start: 2,
      end: 8,
      aiStart: 0,
      aiEnd: 10
    })
  })

  it('handles no candidates', () => {
    expect(autoSelect(project({ target: 60, moments: [] }))).toEqual([])
  })
})

describe('autoSelect top-up', () => {
  it('trims the best moment when the target is shorter than any clip', () => {
    const result = autoSelect(
      project({
        target: 10,
        videos: ['v1'],
        moments: [ai('a', 'v1', 0, 20, 9), ai('b', 'v1', 30, 15, 8)]
      })
    )
    expect(selectedIds(result)).toEqual(['a'])
    expect(result[0]).toMatchObject({ start: 5, end: 15, aiStart: 0, aiEnd: 20 })
    expect(result[1]).toMatchObject({ start: 30, end: 45, selected: false })
  })

  it('fills exactly up to the target, including the crossfade overlap', () => {
    // m 12 s; a (20 s) does not fit (31.6 > 22) → trimmed to 20 − 12 + 0.4 = 8.4 s around 40
    const result = autoSelect(
      project({
        target: 20,
        videos: ['v1'],
        crossfade: true,
        moments: [ai('m', 'v1', 0, 12, 10), ai('a', 'v1', 30, 20, 9)]
      })
    )
    const a = result.find((m) => m.id === 'a')
    expect(a).toMatchObject({ selected: true, start: 35.8, end: 44.2, aiStart: 30, aiEnd: 50 })
    expect(
      effectiveLength(
        result.filter((m) => m.selected),
        0.4
      )
    ).toBeCloseTo(20, 6)
  })

  it('keeps the AI times of a moment that had none recorded', () => {
    const legacy: Moment = { ...ai('a', 'v1', 0, 20, 9), aiStart: undefined, aiEnd: undefined }
    const result = autoSelect(project({ target: 10, videos: ['v1'], moments: [legacy] }))
    expect(result[0]).toMatchObject({ start: 5, end: 15, aiStart: 0, aiEnd: 20 })
  })

  it('does not top up when the remaining budget is below the minimum clip length', () => {
    // m 4.2 s < 0.85 · 5, but only 0.8 s are left (clips are at least 1 s long)
    const result = autoSelect(
      project({
        target: 5,
        videos: ['v1'],
        moments: [ai('m', 'v1', 0, 4.2, 10), ai('a', 'v1', 20, 10, 9)]
      })
    )
    expect(selectedIds(result)).toEqual(['m'])
    expect(result[1]).toMatchObject({ start: 20, end: 30 })
  })

  it('marks a trimmed moment and restores its full length on the next run', () => {
    const short = autoSelect(
      project({ target: 10, videos: ['v1'], moments: [ai('a', 'v1', 0, 20, 9)] })
    )
    expect(short[0]).toMatchObject({
      start: 5,
      end: 15,
      autoTrimmedFrom: { start: 0, end: 20 },
      selected: true
    })

    // a larger target: the full 20 s clip fits again, so it is neither trimmed nor marked
    const long = autoSelect(project({ target: 30, videos: ['v1'], moments: short }))
    expect(long[0]).toMatchObject({ start: 0, end: 20, aiStart: 0, aiEnd: 20, selected: true })
    expect(long[0].autoTrimmedFrom).toBeUndefined()
  })

  it('never undoes a trim made by the user', () => {
    const userTrim: Moment = { ...ai('a', 'v1', 2, 16, 9), aiStart: 0, aiEnd: 20 }
    const kept = autoSelect(project({ target: 30, videos: ['v1'], moments: [userTrim] }))
    expect(kept[0]).toMatchObject({ start: 2, end: 18, aiStart: 0, aiEnd: 20, selected: true })

    // trimmed further for a short reel, then back to the user's 16 s – not the AI's 20 s
    const short = autoSelect(project({ target: 10, videos: ['v1'], moments: kept }))
    expect(short[0]).toMatchObject({ start: 5, end: 15, autoTrimmedFrom: { start: 2, end: 18 } })
    const again = autoSelect(project({ target: 30, videos: ['v1'], moments: short }))
    expect(again[0]).toMatchObject({ start: 2, end: 18, selected: true })
  })

  it('does not top up once 85 % of the target are reached', () => {
    // T = 20, a (17 s) = 85 %; b would need trimming to 3 s
    const result = autoSelect(
      project({
        target: 20,
        videos: ['v1'],
        moments: [ai('a', 'v1', 0, 17, 9), ai('b', 'v1', 30, 10, 8)]
      })
    )
    expect(selectedIds(result)).toEqual(['a'])
  })
})

describe('autoSelect variety cap (≥ 3 videos)', () => {
  // v1 is strong, v2 weak (no diversity pick), v3 decent; all clips 10 s
  const moments = (): Moment[] => [
    ai('a1', 'v1', 0, 10, 9),
    ai('a2', 'v1', 20, 10, 9),
    ai('a3', 'v1', 40, 10, 8),
    ai('a4', 'v1', 60, 10, 8),
    ai('b1', 'v2', 0, 10, 5),
    ai('c1', 'v3', 0, 10, 6)
  ]

  it('limits one video to 40 % of the target while other videos have candidates', () => {
    // T = 30 → cap 12 s per video: a2 would push v1 to 20 s, so the weaker b1 gets the slot
    const result = autoSelect(project({ target: 30, moments: moments() }))
    expect(sorted(selectedIds(result))).toEqual(['a1', 'b1', 'c1'])
  })

  it('does not apply with fewer than three videos', () => {
    const twoVideos = moments().filter((m) => m.videoId !== 'v3')
    const result = autoSelect(project({ target: 30, videos: ['v1', 'v2'], moments: twoVideos }))
    expect(sorted(selectedIds(result))).toEqual(['a1', 'a2', 'a3'])
  })

  it('lets a video exceed the cap when nothing else is left', () => {
    const result = autoSelect(
      project({
        target: 60,
        moments: [
          ai('a1', 'v1', 0, 10, 9),
          ai('a2', 'v1', 15, 10, 9),
          ai('a3', 'v1', 30, 10, 9),
          ai('a4', 'v1', 45, 10, 9),
          ai('a5', 'v1', 60, 10, 9),
          ai('b1', 'v2', 0, 5, 7),
          ai('c1', 'v3', 0, 5, 7)
        ]
      })
    )
    expect(sorted(selectedIds(result))).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'c1'])
  })
})

describe('autoSelect never shows the same footage twice', () => {
  const reel = (target: number | null, moments: Moment[], videos = ['v1']): string[] =>
    selectedIds(autoSelect(project({ target, videos, moments })))

  it('takes only the better of two overlapping clips', () => {
    // a1 widened by the user to 60–74 s overlaps a2 (70–76 s)
    const widened = [ai('a1', 'v1', 60, 14, 8), ai('a2', 'v1', 70, 6, 7)]
    expect(reel(60, widened)).toEqual(['a1'])
    expect(reel(null, widened)).toEqual(['a1'])
    const laterIsBetter = [ai('a1', 'v1', 60, 14, 7), ai('a2', 'v1', 70, 6, 9)]
    expect(reel(60, laterIsBetter)).toEqual(['a2'])
    expect(reel(null, laterIsBetter)).toEqual(['a2'])
    // too weak for the diversity pick: the fill pass skips the overlap too
    expect(reel(60, [ai('x1', 'v1', 0, 10, 5), ai('x2', 'v1', 5, 10, 4)])).toEqual(['x1'])
  })

  it('keeps clips that only touch', () => {
    const moments = [ai('a0', 'v1', 0, 10, 9), ai('a1', 'v1', 10, 6, 8), ai('a2', 'v1', 16, 6, 7)]
    expect(reel(60, moments)).toEqual(['a0', 'a1', 'a2'])
    expect(reel(null, moments)).toEqual(['a0', 'a1', 'a2'])
  })

  it('falls back to the three best clips that do not overlap', () => {
    const weak = [
      ai('e1', 'v1', 0, 4, 6),
      ai('e2', 'v1', 2, 4, 6),
      ai('e3', 'v1', 20, 3, 5),
      ai('e4', 'v1', 30, 2, 5)
    ]
    expect(reel(null, weak)).toEqual(['e1', 'e3', 'e4'])
  })
})

describe('browser safety', () => {
  // the renderer's mock bundles these files; Vite only warns when one pulls in a Node module
  it('imports only @shared and each other', async () => {
    for (const file of ['selection.ts', 'project/order.ts']) {
      const source = await readFile(new URL(file, import.meta.url), 'utf8')
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1])
      const others = imports.filter((i) => !/^(@shared\/|\.\/project\/order$)/.test(i))
      expect(others, file).toEqual([])
    }
  })
})

describe('applyAutoSelect', () => {
  it('replaces selection and order of a draft and marks the reel as automatic again', () => {
    const draft = project({
      target: null,
      moments: [
        { ...ai('late', 'v2', 50, 4, 8), selected: true },
        { ...ai('early', 'v1', 10, 4, 9), selected: false },
        { ...ai('weak', 'v1', 30, 4, 3), selected: true }
      ]
    })
    draft.reelEdited = true
    const expected = autoSelect(draft)
    applyAutoSelect(draft)
    expect(draft.moments).toEqual(expected)
    expect(selectedIds(draft.moments)).toEqual(['early', 'late'])
    expect(draft.reelEdited).toBe(false)
  })
})

describe('autoSelect thresholds at their boundaries', () => {
  const reelLength = (p: Project): number =>
    autoSelect(p)
      .filter((m) => m.selected)
      .reduce((sum, m) => sum + m.end - m.start, 0)

  it('caps one video at exactly 40 % of the target', () => {
    // T = 60 → cap 24 s: v1's a + b fill it exactly, c (3 s) would pass a 45 % cap (27 s)
    const moments = [
      ai('a', 'v1', 0, 12, 9),
      ai('b', 'v1', 20, 12, 9),
      ai('c', 'v1', 40, 3, 8),
      ai('d', 'v2', 0, 10, 5),
      ai('e', 'v3', 0, 10, 5),
      ai('f', 'v2', 20, 10, 5),
      ai('g', 'v3', 20, 10, 5)
    ]
    expect(sorted(selectedIds(autoSelect(project({ target: 60, moments }))))).toEqual([
      'a',
      'b',
      'd',
      'e',
      'f',
      'g'
    ])
  })

  it('tops up a reel at 84.5 % of the target', () => {
    const moments = [ai('a', 'v1', 0, 25, 9), ai('b', 'v2', 0, 25.7, 9), ai('c', 'v3', 0, 20, 3)]
    expect(selectedIds(autoSelect(project({ target: 60, moments })))).toContain('c')
  })

  it('allows 8 % over the target, but at least 2 s', () => {
    // T = 50 → +4 s: b (24.5 s) would make 54.5 s, so it is trimmed in to 20 s instead
    const long = [ai('a', 'v1', 0, 30, 9), ai('b', 'v2', 0, 24.5, 8)]
    expect(reelLength(project({ target: 50, videos: ['v1', 'v2'], moments: long }))).toBe(50)
    // T = 20 → +2 s (8 % = 1.6 s): b (10.5 s) would make 22.5 s, so it is trimmed to 8 s
    const short = [ai('a', 'v1', 0, 12, 9), ai('b', 'v2', 0, 10.5, 8)]
    expect(reelLength(project({ target: 20, videos: ['v1', 'v2'], moments: short }))).toBe(20)
    // 21.8 s lies between 20 + 1.6 and 20 + 2, so only the 2 s floor lets b in whole
    const edge = [ai('a', 'v1', 0, 12, 9), ai('b', 'v2', 0, 9.8, 8)]
    expect(reelLength(project({ target: 20, videos: ['v1', 'v2'], moments: edge }))).toBeCloseTo(
      21.8
    )
  })

  it('rounds a top-up trim to hundredths', () => {
    const moments = [ai('a', 'v1', 0, 10, 9), ai('b', 'v2', 0, 10.333, 8)]
    const b = autoSelect(project({ target: 15, videos: ['v1', 'v2'], moments })).find(
      (m) => m.id === 'b'
    )
    expect(b).toMatchObject({ start: 2.67, end: 7.67, selected: true })
  })
})
