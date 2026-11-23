import { parseIpcError, type IpcErrorCode } from '@shared/ipc'
import { DEFAULT_BRIEF, DEFAULT_EXPORT_SETTINGS, LIMITS } from '@shared/presets'
import type { Project, ProjectMutation } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { CoreError } from './errors'
import { applyMutation, MUTATION_MESSAGES, REEL_MUTATIONS } from './mutations'
import { autoSelect } from './selection'
import { makeMoment, makeProject, makeVideo, selectedIds } from './testing/fixtures'

const apply = applyMutation

function errorCode(run: () => unknown): IpcErrorCode {
  try {
    run()
  } catch (err) {
    expect(err).toBeInstanceOf(CoreError)
    const parsed = parseIpcError(err)
    expect(parsed.message.length).toBeGreaterThan(0)
    return parsed.code
  }
  throw new Error('expected the mutation to throw')
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** two videos (v1 before v2), moments a–d selected in output order a, b, c, d */
function reviewProject(): Project {
  return makeProject({
    videos: [makeVideo({ id: 'v1', durationSec: 60 }), makeVideo({ id: 'v2', durationSec: 40 })],
    moments: [
      makeMoment({ id: 'a', videoId: 'v1', start: 5, end: 9, selected: true }),
      makeMoment({ id: 'x', videoId: 'v1', start: 12, end: 15 }),
      makeMoment({ id: 'b', videoId: 'v1', start: 20, end: 24, selected: true }),
      makeMoment({ id: 'c', videoId: 'v2', start: 2, end: 6, selected: true }),
      makeMoment({ id: 'y', videoId: 'v2', start: 10, end: 13 }),
      makeMoment({ id: 'd', videoId: 'v2', start: 20, end: 25, selected: true })
    ]
  })
}

const ids = (project: Project): string[] => project.moments.map((m) => m.id)

describe('applyMutation – general', () => {
  it('never mutates its input', () => {
    const source = deepFreeze(reviewProject())
    const next = apply(source, { type: 'toggleMoment', momentId: 'x', selected: true })
    expect(next).not.toBe(source)
    expect(source.moments[1].selected).toBe(false)
    expect(next.moments[1].selected).toBe(true)
  })

  it('rejects unknown mutation types and malformed envelopes', () => {
    const project = reviewProject()
    // 'setAllMoments' and 'sortChronologically' were mutations of older builds
    for (const type of ['explode', 'setAllMoments', 'sortChronologically']) {
      const old = { type, selected: true } as unknown as ProjectMutation
      expect(errorCode(() => apply(project, old))).toBe('invalid')
    }
    expect(errorCode(() => apply(project, null as unknown as ProjectMutation))).toBe('invalid')
    expect(errorCode(() => apply(project, 'rename' as unknown as ProjectMutation))).toBe('invalid')
  })
})

describe('rename', () => {
  it('trims the name', () => {
    expect(apply(makeProject(), { type: 'rename', name: '  Rock am Ring  ' }).name).toBe(
      'Rock am Ring'
    )
  })

  it('accepts 80 characters and rejects empty, blank, longer and non-string names', () => {
    expect(apply(makeProject(), { type: 'rename', name: 'x'.repeat(80) }).name).toHaveLength(80)
    for (const name of ['', '   ', 'x'.repeat(81)]) {
      expect(errorCode(() => apply(makeProject(), { type: 'rename', name }))).toBe('invalid')
    }
    const bogus = { type: 'rename', name: 42 } as unknown as ProjectMutation
    expect(errorCode(() => apply(makeProject(), bogus))).toBe('invalid')
  })
})

describe('setBrief', () => {
  const brief = (patch: Record<string, unknown>): Project['brief'] =>
    apply(makeProject(), { type: 'setBrief', patch } as ProjectMutation).brief

  it('merges a partial patch and keeps the prompt verbatim (no trimming while typing)', () => {
    const next = brief({ prompt: 'Only drops ' })
    expect(next).toEqual({ ...DEFAULT_BRIEF, prompt: 'Only drops ' })
  })

  it('clamps the target length to LIMITS and rounds it to whole seconds', () => {
    expect(brief({ targetDurationSec: 5 }).targetDurationSec).toBe(LIMITS.targetDurationSec.min)
    expect(brief({ targetDurationSec: 99_999 }).targetDurationSec).toBe(
      LIMITS.targetDurationSec.max
    )
    expect(brief({ targetDurationSec: 60.4 }).targetDurationSec).toBe(60)
  })

  it('allows "no limit" as target', () => {
    expect(brief({ targetDurationSec: null }).targetDurationSec).toBeNull()
  })

  it('re-selects an untouched reel for a new target length, but never an edited one', () => {
    const project = reviewProject()
    const setTarget = (source: Project, targetDurationSec: number | null): Project =>
      apply(source, { type: 'setBrief', patch: { targetDurationSec } })
    const shorter = setTarget(project, 10)
    const expected = autoSelect({ ...project, brief: { ...project.brief, targetDurationSec: 10 } })
    expect(selectedIds(shorter.moments)).toEqual(selectedIds(expected))
    expect(selectedIds(shorter.moments).length).toBeLessThan(selectedIds(project.moments).length)
    expect(shorter.reelEdited).toBe(false)
    // and back: the longer target brings the clips back
    expect(selectedIds(setTarget(shorter, 60).moments)).toEqual(['a', 'x', 'b', 'c', 'y', 'd'])

    // a reel edited by hand keeps its clips
    const edited = { ...project, reelEdited: true }
    expect(setTarget(edited, 10).moments).toEqual(edited.moments)
    // other brief fields and the same target leave the reel alone
    expect(setTarget(project, 60).moments).toEqual(project.moments)
    expect(apply(project, { type: 'setBrief', patch: { prompt: 'Only drops' } }).moments).toEqual(
      project.moments
    )
  })

  it('rejects invalid values and ignores unknown keys', () => {
    for (const patch of [
      { targetDurationSec: 'three' },
      { targetDurationSec: Number.NaN },
      { targetDurationSec: Number.POSITIVE_INFINITY },
      { prompt: 7 }
    ]) {
      expect(errorCode(() => brief(patch))).toBe('invalid')
    }
    expect(brief({ colour: 'blue' })).toEqual(DEFAULT_BRIEF)
    expect(
      errorCode(() =>
        apply(makeProject(), { type: 'setBrief', patch: null } as unknown as ProjectMutation)
      )
    ).toBe('invalid')
  })
})

describe('setExportSettings', () => {
  const settings = (patch: Record<string, unknown>): Project['exportSettings'] =>
    apply(makeProject(), { type: 'setExportSettings', patch } as ProjectMutation).exportSettings

  it('merges valid values', () => {
    const next = settings({ aspect: '1:1', fit: 'blur', transition: 'crossfade' })
    expect(next).toEqual({
      ...DEFAULT_EXPORT_SETTINGS,
      aspect: '1:1',
      fit: 'blur',
      transition: 'crossfade'
    })
  })

  it('validates the choices', () => {
    for (const patch of [{ aspect: '3:2' }, { fit: 'stretch' }, { transition: 'wipe' }]) {
      expect(errorCode(() => settings(patch))).toBe('invalid')
    }
  })

  it('stores nothing but the four choices', () => {
    // what the export step of older versions could set: fixed now (EXPORT_FIXED)
    expect(settings({ aspect: '4:5', frameRate: 60, bitrate: '8M' })).toEqual({
      ...DEFAULT_EXPORT_SETTINGS,
      aspect: '4:5'
    })
  })

  it('normalises the output folder and accepts null / empty as "app default"', () => {
    expect(settings({ outputDir: '/Users/jan/Movies/../Desktop/Reels/' }).outputDir).toBe(
      '/Users/jan/Desktop/Reels/'
    )
    expect(settings({ outputDir: null }).outputDir).toBeNull()
    expect(settings({ outputDir: '' }).outputDir).toBeNull()
    expect(errorCode(() => settings({ outputDir: 'relative/dir' }))).toBe('invalid')
  })
})

describe('toggleMoment', () => {
  it('toggles one moment; taking it back in restores its place ("Undo")', () => {
    const next = apply(reviewProject(), { type: 'toggleMoment', momentId: 'b', selected: false })
    expect(selectedIds(next.moments)).toEqual(['a', 'c', 'd'])
    const back = apply(next, { type: 'toggleMoment', momentId: 'b', selected: true })
    expect(selectedIds(back.moments)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('reports unknown moments and invalid flags', () => {
    expect(
      errorCode(() =>
        apply(reviewProject(), { type: 'toggleMoment', momentId: 'zz', selected: true })
      )
    ).toBe('not-found')
    const bogus = {
      type: 'toggleMoment',
      momentId: 'a',
      selected: 'ja'
    } as unknown as ProjectMutation
    expect(errorCode(() => apply(reviewProject(), bogus))).toBe('invalid')
  })
})

describe('updateMomentTimes / resetMomentTimes', () => {
  it('rounds to 0.01 s and keeps the AI times', () => {
    const next = apply(reviewProject(), {
      type: 'updateMomentTimes',
      momentId: 'a',
      start: 4.123,
      end: 10.987
    })
    expect(next.moments[0]).toMatchObject({ start: 4.12, end: 10.99, aiStart: 5, aiEnd: 9 })
  })

  it('clamps to the video duration', () => {
    const next = apply(reviewProject(), {
      type: 'updateMomentTimes',
      momentId: 'y',
      start: -3,
      end: 99
    })
    expect(next.moments.find((m) => m.id === 'y')).toMatchObject({ start: 0, end: 40 })
  })

  it('never rounds past the end of a video with a fractional duration', () => {
    const project = makeProject({
      videos: [makeVideo({ id: 'v1', durationSec: 12.345 })],
      moments: [makeMoment({ id: 'a', videoId: 'v1', start: 1, end: 3 })]
    })
    const next = apply(project, {
      type: 'updateMomentTimes',
      momentId: 'a',
      start: 10,
      end: 12.345
    })
    expect(next.moments[0].end).toBe(12.34)
  })

  it(`enforces the minimum length of ${LIMITS.minMomentSec} s`, () => {
    const exact = apply(reviewProject(), {
      type: 'updateMomentTimes',
      momentId: 'a',
      start: 5,
      end: 5.5
    })
    expect(exact.moments[0]).toMatchObject({ start: 5, end: 5.5 })
    for (const [start, end] of [
      [5, 5.49],
      [9, 5],
      [60, 70]
    ]) {
      expect(
        errorCode(() =>
          apply(reviewProject(), { type: 'updateMomentTimes', momentId: 'a', start, end })
        )
      ).toBe('invalid')
    }
  })

  it('rejects non-numbers and unknown moments', () => {
    const bogus = {
      type: 'updateMomentTimes',
      momentId: 'a',
      start: '1',
      end: 3
    } as unknown as ProjectMutation
    expect(errorCode(() => apply(reviewProject(), bogus))).toBe('invalid')
    expect(
      errorCode(() =>
        apply(reviewProject(), { type: 'updateMomentTimes', momentId: 'nope', start: 1, end: 3 })
      )
    ).toBe('not-found')
  })

  it('resets to the AI times', () => {
    const trimmed = apply(reviewProject(), {
      type: 'updateMomentTimes',
      momentId: 'a',
      start: 6,
      end: 8
    })
    const reset = apply(trimmed, { type: 'resetMomentTimes', momentId: 'a' })
    expect(reset.moments[0]).toMatchObject({ start: 5, end: 9 })
  })

  it('is no edit when the times stay the same (e.g. a trim key held at a limit)', () => {
    const auto = reviewProject()
    auto.moments[0] = { ...auto.moments[0], autoTrimmedFrom: { start: 4, end: 10 } }
    const same = apply(auto, { type: 'updateMomentTimes', momentId: 'a', start: 5, end: 9 })
    expect(same.reelEdited).toBe(false)
    expect(same.moments[0].autoTrimmedFrom).toEqual({ start: 4, end: 10 })
  })

  it('turns an auto-trim into the user’s own trim on edit, and clears it on reset', () => {
    const auto = reviewProject()
    auto.moments[0] = { ...auto.moments[0], autoTrimmedFrom: { start: 5, end: 9 } }
    const edited = apply(auto, { type: 'updateMomentTimes', momentId: 'a', start: 6, end: 8 })
    expect(edited.moments[0].autoTrimmedFrom).toBeUndefined()
    const reset = apply(auto, { type: 'resetMomentTimes', momentId: 'a' })
    expect(reset.moments[0].autoTrimmedFrom).toBeUndefined()
  })

  it('leaves a clip without AI times alone on reset', () => {
    // an own clip of an older version
    const project = makeProject({
      videos: [makeVideo({ id: 'v1' })],
      moments: [
        {
          ...makeMoment({ id: 'm', videoId: 'v1', start: 1, end: 4 }),
          aiStart: undefined,
          aiEnd: undefined
        }
      ]
    })
    expect(apply(project, { type: 'resetMomentTimes', momentId: 'm' }).moments[0]).toMatchObject({
      start: 1,
      end: 4
    })
  })
})

describe('no footage twice in the highlight video (hand edits)', () => {
  const trim = (project: Project, momentId: string, start: number, end: number): Project =>
    apply(project, { type: 'updateMomentTimes', momentId, start, end })
  const timesOf = (project: Project, id: string): [number, number] => {
    const moment = project.moments.find((m) => m.id === id)
    return [moment?.start ?? NaN, moment?.end ?? NaN]
  }

  it('stops a trim of a clip of the highlight video at its neighbours there', () => {
    // v1: a 5–9 and b 20–24 are in the highlight video, x 12–15 is not
    expect(timesOf(trim(reviewProject(), 'a', 3, 22), 'a')).toEqual([3, 20])
    expect(timesOf(trim(reviewProject(), 'b', 7, 30), 'b')).toEqual([9, 30])
    // a clip that is not in the highlight video stops nobody, and is not stopped
    expect(timesOf(trim(reviewProject(), 'a', 5, 14), 'a')).toEqual([5, 14])
    expect(timesOf(trim(reviewProject(), 'x', 6, 22), 'x')).toEqual([6, 22])
    // clips of other videos never count
    expect(timesOf(trim(reviewProject(), 'c', 0, 15), 'c')).toEqual([0, 15])
  })

  it('refuses times that lie behind a neighbour', () => {
    expect(errorCode(() => trim(reviewProject(), 'a', 30, 36))).toBe('invalid')
    expect(errorCode(() => trim(reviewProject(), 'b', 1, 4))).toBe('invalid')
  })

  it('leaves an overlap of an old project alone, but never lets it grow', () => {
    const old = reviewProject()
    old.moments[2] = { ...old.moments[2], start: 8 } // b 8–24 shares 8–9 with a 5–9
    expect(timesOf(trim(old, 'b', 7, 24), 'b')).toEqual([8, 24])
    expect(timesOf(trim(old, 'a', 5, 10), 'a')).toEqual([5, 9])
    // the other edge still moves, and the overlap can be trimmed away
    expect(timesOf(trim(old, 'b', 8, 30), 'b')).toEqual([8, 30])
    expect(timesOf(trim(old, 'a', 4, 8), 'a')).toEqual([4, 8])
    expect(timesOf(trim(old, 'b', 10, 24), 'b')).toEqual([10, 24])
  })

  it('does not take in a clip that shares footage with the highlight video', () => {
    const grown = trim(reviewProject(), 'a', 5, 13) // a now covers 12–13 of x (12–15)
    const takeIn: ProjectMutation = { type: 'toggleMoment', momentId: 'x', selected: true }
    expect(errorCode(() => apply(grown, takeIn))).toBe('invalid')
    try {
      apply(grown, takeIn)
    } catch (err) {
      expect(parseIpcError(err).message).toBe(MUTATION_MESSAGES.footageTwice)
    }
    // clips that only touch share nothing
    const touching = trim(reviewProject(), 'a', 5, 12)
    expect(selectedIds(apply(touching, takeIn).moments)).toEqual(['a', 'x', 'b', 'c', 'd'])
  })

  it('still takes a clip out, and leaves a clip that is already in alone (old project)', () => {
    const old = reviewProject()
    old.moments[2] = { ...old.moments[2], start: 8 }
    expect(
      selectedIds(apply(old, { type: 'toggleMoment', momentId: 'b', selected: false }).moments)
    ).toEqual(['a', 'c', 'd'])
    expect(
      selectedIds(apply(old, { type: 'toggleMoment', momentId: 'b', selected: true }).moments)
    ).toEqual(['a', 'b', 'c', 'd'])
  })

  it('does not reset to Gemini times that share footage with the highlight video', () => {
    // a 5–7 (Gemini: 5–9), then b grows into the room a left: b 8–24
    const project = trim(trim(reviewProject(), 'a', 5, 7), 'b', 8, 24)
    expect(timesOf(project, 'b')).toEqual([8, 24])
    const reset: ProjectMutation = { type: 'resetMomentTimes', momentId: 'a' }
    expect(errorCode(() => apply(project, reset))).toBe('invalid')
    // out of the highlight video the clip is free again
    const out = apply(project, { type: 'toggleMoment', momentId: 'a', selected: false })
    expect(timesOf(apply(out, reset), 'a')).toEqual([5, 9])
  })
})

describe('reorderMoment', () => {
  const reorder = (momentId: string, toIndex: number): string[] =>
    selectedIds(apply(reviewProject(), { type: 'reorderMoment', momentId, toIndex }).moments)

  it('moves a selected moment to a position among the selected ones', () => {
    expect(reorder('d', 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(reorder('a', 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(reorder('b', 1)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('places it before the selected moment currently at toIndex in the full array', () => {
    const next = apply(reviewProject(), { type: 'reorderMoment', momentId: 'a', toIndex: 1 })
    // selected after removing a: [b, c, d] → a goes right before c; unselected x, y keep their places
    expect(ids(next)).toEqual(['x', 'b', 'a', 'c', 'y', 'd'])
  })

  it('appends after the last selected moment when toIndex ≥ count', () => {
    expect(reorder('a', 3)).toEqual(['b', 'c', 'd', 'a'])
    expect(reorder('a', 99)).toEqual(['b', 'c', 'd', 'a'])
    const next = apply(reviewProject(), { type: 'reorderMoment', momentId: 'b', toIndex: 3 })
    expect(ids(next)).toEqual(['a', 'x', 'c', 'y', 'd', 'b'])
  })

  it('keeps the order when there is nothing to order against', () => {
    const project = makeProject({
      videos: [makeVideo({ id: 'v1' })],
      moments: [
        makeMoment({ id: 'a', videoId: 'v1', start: 1, end: 3, selected: true }),
        makeMoment({ id: 'b', videoId: 'v1', start: 5, end: 8 })
      ]
    })
    expect(ids(apply(project, { type: 'reorderMoment', momentId: 'a', toIndex: 0 }))).toEqual([
      'a',
      'b'
    ])
  })

  it('validates the index and the moment', () => {
    for (const toIndex of [-1, 1.5, Number.NaN]) {
      expect(
        errorCode(() => apply(reviewProject(), { type: 'reorderMoment', momentId: 'a', toIndex }))
      ).toBe('invalid')
    }
    expect(
      errorCode(() => apply(reviewProject(), { type: 'reorderMoment', momentId: '??', toIndex: 0 }))
    ).toBe('not-found')
  })
})

describe('reelEdited', () => {
  /** one valid hand edit of the reel per mutation type (against reviewProject) */
  const reelEdits: ProjectMutation[] = [
    { type: 'toggleMoment', momentId: 'x', selected: true },
    { type: 'updateMomentTimes', momentId: 'a', start: 6, end: 9 },
    { type: 'resetMomentTimes', momentId: 'a' },
    { type: 'reorderMoment', momentId: 'd', toIndex: 0 }
  ]
  const otherEdits: ProjectMutation[] = [
    { type: 'rename', name: 'Summer' },
    { type: 'setBrief', patch: { targetDurationSec: 30, prompt: 'Only drops' } },
    { type: 'setExportSettings', patch: { transition: 'crossfade' } }
  ]
  // compile-time guard: a new mutation type must be sorted into one of the two lists
  const allTypes: Record<ProjectMutation['type'], true> = {
    rename: true,
    setBrief: true,
    setExportSettings: true,
    toggleMoment: true,
    updateMomentTimes: true,
    resetMomentTimes: true,
    reorderMoment: true
  }

  it('sorts every mutation type into hand edits of the reel and other changes', () => {
    const types = [...reelEdits, ...otherEdits].map((m) => m.type).sort()
    expect(types).toEqual(Object.keys(allTypes).sort())
    expect(reelEdits.map((m) => m.type).sort()).toEqual([...REEL_MUTATIONS].sort())
  })

  it('is set by every hand edit of the reel', () => {
    expect(reviewProject().reelEdited).toBe(false)
    for (const mutation of reelEdits) {
      expect(apply(reviewProject(), mutation).reelEdited, mutation.type).toBe(true)
    }
  })

  it('is left as it is by name, brief (incl. the target length) and export settings', () => {
    for (const mutation of otherEdits) {
      expect(apply(reviewProject(), mutation).reelEdited, mutation.type).toBe(false)
      const edited = { ...reviewProject(), reelEdited: true }
      expect(apply(edited, mutation).reelEdited, mutation.type).toBe(true)
    }
  })
})
