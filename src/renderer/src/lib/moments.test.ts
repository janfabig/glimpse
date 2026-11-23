import { describe, expect, it } from 'vitest'
import type { Moment, Project } from '@shared/types'
// the real mutation from main: the UI's reorder maths must match what main does with it
import { applyMutation } from '../../../main/core/mutations'
import { trimBounds } from '../../../main/core/selection'
import {
  describeAutoSelect,
  dragEdge,
  editPoint,
  effectiveLength,
  lengthStatus,
  reorderTarget,
  SUGGESTION_LIMIT,
  suggestions,
  withInPoint,
  withOutPoint,
  zoomWindow
} from './moments'

function moment(id: string, videoId: string, start: number, selected = true): Moment {
  return {
    id,
    videoId,
    start,
    end: start + 4,
    title: id,
    reason: '',
    score: 7,
    selected
  }
}

function project(moments: Moment[]): Project {
  return {
    schemaVersion: 1,
    id: 'p',
    name: 'Test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    videos: ['v1', 'v2'].map((id) => ({
      id,
      path: `/x/${id}.mp4`,
      fileName: `${id}.mp4`,
      sizeBytes: 1,
      durationSec: 300,
      width: 1440,
      height: 1920,
      hasAudio: true,
      recordedAt: null,
      fingerprint: id,
      proxyPath: null,
      posterPath: null,
      spritePath: null,
      spriteInfo: null
    })),
    status: {},
    brief: { prompt: '', targetDurationSec: 60 },
    analyses: {},
    remoteFiles: {},
    moments,
    reelEdited: false,
    exportSettings: {
      aspect: '9:16',
      fit: 'crop',
      transition: 'cut',
      outputDir: null
    },
    exports: []
  }
}

const selectedOrder = (p: Project): string[] => p.moments.filter((m) => m.selected).map((m) => m.id)

describe('effectiveLength', () => {
  const ranges = [
    { start: 0, end: 4 },
    { start: 10, end: 16 },
    { start: 20, end: 25 }
  ]
  it('sums plain cuts', () => {
    expect(effectiveLength(ranges, { transition: 'cut' })).toBe(15)
  })
  it('subtracts the crossfade overlaps', () => {
    // two overlaps of 0.4 s
    expect(effectiveLength(ranges, { transition: 'crossfade' })).toBeCloseTo(14.2, 9)
  })
  it('is 0 for an empty reel', () => {
    expect(effectiveLength([], { transition: 'crossfade' })).toBe(0)
  })
})

describe('reorderTarget', () => {
  it('maps drop slots to the position after removing the moved clip', () => {
    expect(reorderTarget(0, 2, 4)).toBe(1)
    expect(reorderTarget(3, 0, 4)).toBe(0)
    expect(reorderTarget(1, 4, 4)).toBe(3)
  })
  it('returns null when the clip would stay where it is', () => {
    expect(reorderTarget(2, 2, 4)).toBeNull()
    expect(reorderTarget(2, 3, 4)).toBeNull()
  })

  it('produces the intended order with the reorderMoment mutation (selected and unselected mixed)', () => {
    // a, x (unselected), b, c, y (unselected), d
    const base = project([
      moment('a', 'v1', 0),
      moment('x', 'v1', 5, false),
      moment('b', 'v1', 10),
      moment('c', 'v2', 0),
      moment('y', 'v2', 5, false),
      moment('d', 'v2', 10)
    ])
    const cases: { from: number; slot: number; expected: string[] }[] = [
      { from: 0, slot: 2, expected: ['b', 'a', 'c', 'd'] },
      { from: 0, slot: 4, expected: ['b', 'c', 'd', 'a'] },
      { from: 3, slot: 0, expected: ['d', 'a', 'b', 'c'] },
      { from: 2, slot: 1, expected: ['a', 'c', 'b', 'd'] },
      { from: 1, slot: 3, expected: ['a', 'c', 'b', 'd'] }
    ]
    for (const { from, slot, expected } of cases) {
      const ids = selectedOrder(base)
      const toIndex = reorderTarget(from, slot, ids.length)
      expect(toIndex).not.toBeNull()
      const next = applyMutation(base, {
        type: 'reorderMoment',
        momentId: ids[from],
        toIndex: toIndex!
      })
      expect(selectedOrder(next)).toEqual(expected)
      // unselected moments are kept
      expect(next.moments).toHaveLength(6)
    }
  })

  it('moves one step up and down like the arrow buttons', () => {
    const base = project([moment('a', 'v1', 0), moment('b', 'v1', 10), moment('c', 'v1', 20)])
    const up = applyMutation(base, { type: 'reorderMoment', momentId: 'c', toIndex: 1 })
    expect(selectedOrder(up)).toEqual(['a', 'c', 'b'])
    const down = applyMutation(base, { type: 'reorderMoment', momentId: 'a', toIndex: 1 })
    expect(selectedOrder(down)).toEqual(['b', 'a', 'c'])
  })
})

describe('lengthStatus', () => {
  it('uses the tolerance of the automatic selection', () => {
    expect(lengthStatus(62, 60).state).toBe('fits')
    expect(lengthStatus(58, 60).state).toBe('fits')
    expect(lengthStatus(70, 60)).toMatchObject({ state: 'over', delta: 10 })
    expect(lengthStatus(40, 60)).toMatchObject({ state: 'under', delta: -20 })
    expect(lengthStatus(100, 180).state).toBe('under')
    expect(lengthStatus(12, null).state).toBe('free')
  })
})

describe('trimming', () => {
  const range = { start: 10, end: 16 }
  /** a clip alone in a 300 s video */
  const video = { min: 0, max: 300 }
  /** a clip between two neighbours of the highlight video: one ends at 8, one starts at 20 */
  const gap = { min: 8, max: 20 }
  it('sets the in point, moving the clip when the playhead is behind the out point', () => {
    expect(withInPoint(range, 12, video, 0.5)).toEqual({ start: 12, end: 16 })
    expect(withInPoint(range, 20, video, 0.5)).toEqual({ start: 20, end: 26 })
    expect(withInPoint(range, 298, video, 0.5)).toEqual({ start: 298, end: 300 })
  })
  it('sets the out point, moving the clip when the playhead is before the in point', () => {
    expect(withOutPoint(range, 14, video, 0.5)).toEqual({ start: 10, end: 14 })
    expect(withOutPoint(range, 5, video, 0.5)).toEqual({ start: 0, end: 5 })
    expect(withOutPoint(range, 0.1, video, 0.5)).toEqual({ start: 0, end: 0.5 })
  })
  it('moves one edge without crossing the other or leaving the video', () => {
    expect(dragEdge(range, 'start', 9.5, video, 0.5)).toEqual({ start: 9.5, end: 16 })
    expect(dragEdge(range, 'end', 16.5, video, 0.5)).toEqual({ start: 10, end: 16.5 })
    expect(dragEdge(range, 'start', 15.8, video, 0.5)).toEqual({ start: 15.5, end: 16 })
    expect(dragEdge({ start: 10, end: 10.6 }, 'start', 10.5, video, 0.5)).toEqual({
      start: 10.1,
      end: 10.6
    })
    expect(dragEdge({ start: 0.2, end: 3 }, 'start', -0.3, video, 0.5)).toEqual({
      start: 0,
      end: 3
    })
    expect(dragEdge({ start: 290, end: 299.8 }, 'end', 300.3, video, 0.5)).toEqual({
      start: 290,
      end: 300
    })
    expect(dragEdge(range, 'end', 400, video, 0.5)).toEqual({ start: 10, end: 300 })
  })
  it('stops at the neighbours in the highlight video like at the ends of the video', () => {
    expect(dragEdge(range, 'start', 7, gap, 0.5)).toEqual({ start: 8, end: 16 })
    expect(dragEdge(range, 'end', 24, gap, 0.5)).toEqual({ start: 10, end: 20 })
    // “Here” on a playhead inside or behind a neighbour: up to the neighbour, not into it
    expect(withInPoint(range, 5, gap, 0.5)).toEqual({ start: 8, end: 16 })
    expect(withInPoint(range, 18, gap, 0.5)).toEqual({ start: 18, end: 20 })
    expect(withInPoint(range, 22, gap, 0.5)).toEqual({ start: 19.5, end: 20 })
    expect(withOutPoint(range, 30, gap, 0.5)).toEqual({ start: 10, end: 20 })
    expect(withOutPoint(range, 9, gap, 0.5)).toEqual({ start: 8, end: 9 })
    expect(withOutPoint(range, 2, gap, 0.5)).toEqual({ start: 8, end: 8.5 })
  })
  it('sends main only trims it accepts as they are', () => {
    // a ffprobe duration off the 0.01 s grid; b is the neighbour of a in the highlight video
    const base = project([
      { ...moment('a', 'v1', 10), end: 16 },
      { ...moment('b', 'v1', 55), end: 62.46 }
    ])
    base.videos[0].durationSec = 62.466667
    const [a, b] = base.moments
    const save = (id: string, next: { start: number; end: number }): void => {
      const saved = applyMutation(base, { type: 'updateMomentTimes', momentId: id, ...next })
      expect(saved.moments.find((m) => m.id === id)).toMatchObject(next)
    }
    const roomOfB = trimBounds(b, base.moments, 62.466667)
    expect(roomOfB).toEqual({ min: 16, max: 62.46 })
    // I near the end of the video: 0.5 s must be left on main's grid
    expect(withInPoint(b, 62.1, roomOfB, 0.5)).toEqual({ start: 61.96, end: 62.46 })
    save('b', withInPoint(b, 62.1, roomOfB, 0.5))
    save('b', withOutPoint(b, 80, roomOfB, 0.5))
    save('b', dragEdge(b, 'end', 80, roomOfB, 0.5))
    save('b', dragEdge(b, 'start', 3, roomOfB, 0.5))
    const roomOfA = trimBounds(a, base.moments, 62.466667)
    save('a', dragEdge(a, 'end', 60, roomOfA, 0.5))
    save('a', withInPoint(a, 58, roomOfA, 0.5))
    save('a', withOutPoint(a, 58, roomOfA, 0.5))
  })
  it('plays an edit from the new start, or from 2 s before the new end', () => {
    expect(editPoint(range, 'start')).toBe(10)
    expect(editPoint(range, 'end')).toBe(14)
    expect(editPoint({ start: 10, end: 11.5 }, 'end')).toBe(10)
  })
})

describe('suggestions', () => {
  const ids = (p: Project, keepId?: string): string[] => suggestions(p, keepId).map((m) => m.id)
  /** `count` unselected clips s1, s2, … of v1 with falling scores (s1 is the best) */
  const ranked = (count: number): Moment[] =>
    Array.from({ length: count }, (_, i) => ({
      ...moment(`s${i + 1}`, 'v1', 10 * i, false),
      score: Math.max(1, 10 - i),
      // the scores end at 1: the longer clip is the worse one from there on
      end: 10 * i + 4 + Math.max(0, i - 9) * 0.1
    }))

  it('lists the clips that are not in the highlight video best first, the shorter first on a tie, then in video order', () => {
    const p = project([
      { ...moment('v2-best', 'v2', 50, false), score: 9 },
      { ...moment('v1-long', 'v1', 30, false), end: 38 },
      moment('v2-early', 'v2', 10, false),
      moment('v1-late', 'v1', 20, false),
      moment('v1-early', 'v1', 12, false),
      { ...moment('kept', 'v1', 5, true), score: 8 },
      { ...moment('reel', 'v1', 60, true), score: 10 }
    ])
    expect(ids(p)).toEqual(['v2-best', 'v1-early', 'v1-late', 'v2-early', 'v1-long'])
    // keepId stays in its place by score although it is selected
    expect(ids(p, 'kept')).toEqual([
      'v2-best',
      'kept',
      'v1-early',
      'v1-late',
      'v2-early',
      'v1-long'
    ])
  })

  it('shows only the 10 best', () => {
    expect(SUGGESTION_LIMIT).toBe(10)
    const best = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10']
    // in any order of the project's moments
    expect(ids(project(ranked(13).reverse()))).toEqual(best)
    expect(ids(project(ranked(10)))).toEqual(best)
    expect(ids(project(ranked(3)))).toEqual(['s1', 's2', 's3'])
    // a clip in the highlight video takes no place
    const reel = { ...moment('reel', 'v2', 0, true), score: 10 }
    expect(ids(project([reel, ...ranked(13)]))).toEqual(best)
  })

  it('keeps the clip shown in the editor, also when it is not among the 10 best', () => {
    const p = project(ranked(13))
    const best = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10']
    // among the 10 best: it is one of them
    expect(ids(p, 's4')).toEqual(best)
    // below them: an eleventh row at its place
    expect(ids(p, 's12')).toEqual([...best, 's12'])
    expect(ids(p, 'unknown')).toEqual(best)
  })

  it('keeps a clip X just took into the highlight video in its place, next to the 10 best others', () => {
    const moments = ranked(13).map((m) => (m.id === 's3' ? { ...m, selected: true } : m))
    const p = project(moments)
    // the rows: s11 moved up
    expect(ids(p)).toEqual(['s1', 's2', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11'])
    // what the arrow keys walk: s3 is still between s2 and s4
    expect(ids(p, 's3')).toEqual([
      's1',
      's2',
      's3',
      's4',
      's5',
      's6',
      's7',
      's8',
      's9',
      's10',
      's11'
    ])
  })
})

describe('zoomWindow', () => {
  it('centres the clip with context and stays inside the video', () => {
    expect(zoomWindow({ start: 100, end: 106 }, 300)).toEqual({ start: 91, end: 115 })
    expect(zoomWindow({ start: 1, end: 5 }, 300)).toEqual({ start: 0, end: 24 })
    expect(zoomWindow({ start: 295, end: 299 }, 300)).toEqual({ start: 276, end: 300 })
    expect(zoomWindow({ start: 2, end: 8 }, 12)).toEqual({ start: 0, end: 12 })
    const long = zoomWindow({ start: 50, end: 70 }, 300)
    expect(long.end - long.start).toBeCloseTo(64)
  })
})

describe('describeAutoSelect', () => {
  it('says that selection and order are replaced and trims stay', () => {
    const base = project([])
    expect(describeAutoSelect(base)).toBe(
      'Glimpse selects the best moments again to match the target length of 1:00 min. Your ' +
        'selection and the order of the clips are replaced. Your trims are kept.'
    )
    expect(describeAutoSelect({ brief: { ...base.brief, targetDurationSec: null } })).toBe(
      'Glimpse selects all strong moments again. Your selection and the order of the clips are ' +
        'replaced. Your trims are kept.'
    )
  })
})
