// Automatic clip selection for the brief's target length (docs/ARCHITECTURE.md §5).
// The renderer's mock runs this file too: import nothing Node-only (selection.test.ts checks it).

import { EXPORT_FIXED, LIMITS } from '@shared/presets'
import type { Moment, Project } from '@shared/types'
import { round2 } from '@shared/util'
import { chronologicalComparator } from './project/order'

const EPS = 1e-6
/** scores that count as strong when there is no target length */
const STRONG_SCORE = 7
/** minimum score for the one-per-video diversity pick */
const DIVERSITY_SCORE = 6
/** with ≥ 3 videos, one video may fill at most this share of the target (unless nothing else is left) */
const VIDEO_SHARE_CAP = 0.4
const MIN_VIDEOS_FOR_CAP = 3
/** below this share of the target, the best remaining moment is trimmed to fill the gap */
const TOP_UP_THRESHOLD = 0.85

const duration = (m: Pick<Moment, 'start' | 'end'>): number => m.end - m.start

/** score desc, then shorter first; ties keep their (chronological) input order */
const byScoreThenShorter = (a: Moment, b: Moment): number =>
  b.score - a.score || duration(a) - duration(b)

/** overlap of two consecutive clips in the reel */
export function transitionOverlap(project: Pick<Project, 'exportSettings'>): number {
  return project.exportSettings.transition === 'crossfade' ? EXPORT_FIXED.crossfadeSec : 0
}

/** reel length of a list of clips: Σ duration − overlap · (n − 1) */
export function effectiveLength(
  moments: readonly Pick<Moment, 'start' | 'end'>[],
  overlap: number
): number {
  if (moments.length === 0) return 0
  return moments.reduce((sum, m) => sum + duration(m), 0) - overlap * (moments.length - 1)
}

/** the same seconds of the same video – clips that only touch share none */
export function sharesFootage(
  a: Pick<Moment, 'videoId' | 'start' | 'end'>,
  b: Pick<Moment, 'videoId' | 'start' | 'end'>
): boolean {
  return a.videoId === b.videoId && a.start < b.end && b.start < a.end
}

/** would `moment` (at `times`) show footage that another clip of the highlight video shows? */
export function sharesReelFootage(
  moments: readonly Moment[],
  moment: Pick<Moment, 'id' | 'videoId' | 'start' | 'end'>,
  times: { start: number; end: number } = moment
): boolean {
  const range = { videoId: moment.videoId, start: times.start, end: times.end }
  return moments.some((m) => m.selected && m.id !== moment.id && sharesFootage(m, range))
}

/**
 * How far a clip can be trimmed by hand: inside its video (on the 0.01 s grid), and a clip of the
 * highlight video only up to its neighbours there, so no footage is in it twice. An edge that
 * already lies inside a neighbour (projects of older versions) may stay, but moves no further in.
 */
export function trimBounds(
  moment: Pick<Moment, 'id' | 'videoId' | 'start' | 'end' | 'selected'>,
  moments: readonly Pick<Moment, 'id' | 'videoId' | 'start' | 'end' | 'selected'>[],
  durationSec: number
): { min: number; max: number } {
  let min = 0
  let max = Math.floor(durationSec * 100) / 100
  if (!moment.selected) return { min, max }
  for (const other of moments) {
    if (!other.selected || other.id === moment.id || other.videoId !== moment.videoId) continue
    if (other.start < moment.start) min = Math.max(min, Math.min(other.end, moment.start))
    else max = Math.min(max, Math.max(other.start, moment.end))
  }
  return { min, max }
}

interface Picker {
  picked: Set<string>
  trimmed: Map<string, { start: number; end: number }>
}

function pickWithoutTarget(moments: Moment[], picker: Picker): void {
  const strong = moments.filter((m) => m.score >= STRONG_SCORE)
  const taken: Moment[] = []
  let left = strong.length > 0 ? strong.length : 3
  // by score, so the better of two overlapping moments wins
  for (const moment of (strong.length > 0 ? strong : [...moments]).sort(byScoreThenShorter)) {
    if (left === 0) break
    if (taken.some((t) => sharesFootage(t, moment))) continue
    picker.picked.add(moment.id)
    taken.push(moment)
    left--
  }
}

function pickForTarget(project: Project, target: number, moments: Moment[], picker: Picker): void {
  const overlap = transitionOverlap(project)
  const tolerance = Math.max(2, 0.08 * target)
  const videoLoad = new Map<string, number>()
  const taken: Moment[] = []
  let sum = 0
  let count = 0

  const effective = (s: number, n: number): number => (n === 0 ? 0 : s - overlap * (n - 1))
  const free = (m: Moment): boolean => !taken.some((t) => sharesFootage(t, m))
  const fits = (m: Moment): boolean =>
    free(m) && effective(sum + duration(m), count + 1) <= target + tolerance + EPS
  const add = (m: Moment, length = duration(m)): void => {
    picker.picked.add(m.id)
    taken.push(m)
    sum += length
    count++
    videoLoad.set(m.videoId, (videoLoad.get(m.videoId) ?? 0) + length)
  }
  // the top-up trim stays inside its moment, so a free untrimmed moment stays free
  const remaining = (): Moment[] =>
    moments.filter((m) => !picker.picked.has(m.id) && free(m)).sort(byScoreThenShorter)

  // 1. diversity: the best decent moment of every video – the best of them first, so a tight
  // target goes to the best videos (equal scores keep the video order)
  const bestPerVideo = project.videos.flatMap((video) =>
    moments
      .filter((m) => m.videoId === video.id && m.score >= DIVERSITY_SCORE)
      .sort(byScoreThenShorter)
      .slice(0, 1)
  )
  for (const best of bestPerVideo.sort((a, b) => b.score - a.score)) if (fits(best)) add(best)

  // 2. fill by score; with enough videos, cap each video's share first
  const capActive = new Set(moments.map((m) => m.videoId)).size >= MIN_VIDEOS_FOR_CAP
  const cap = VIDEO_SHARE_CAP * target
  for (const moment of remaining()) {
    const overCap = capActive && (videoLoad.get(moment.videoId) ?? 0) + duration(moment) > cap + EPS
    if (!overCap && fits(moment)) add(moment)
  }
  if (capActive) {
    for (const moment of remaining()) if (fits(moment)) add(moment)
  }

  // 3. top up: trim the best remaining moment around its centre to exactly fill the target
  if (effective(sum, count) >= TOP_UP_THRESHOLD * target - EPS) return
  const best = remaining()[0]
  if (!best) return
  const length = Math.min(duration(best), target - sum + overlap * count)
  if (length < LIMITS.clipSec.min - EPS) return
  const centre = (best.start + best.end) / 2
  const start = Math.max(best.start, round2(centre - length / 2))
  const end = Math.min(best.end, round2(centre + length / 2))
  picker.trimmed.set(best.id, { start, end })
  add(best, end - start)
}

/** undoes an earlier top-up trim, so every run starts from the clip as the AI or the user left it */
function untrim(moment: Moment): Moment {
  if (!moment.autoTrimmedFrom) return moment
  const { autoTrimmedFrom: before, ...rest } = moment
  return { ...rest, start: before.start, end: before.end }
}

/**
 * Recomputes the `selected` flags of all moments for the brief's target length. Returns a new array
 * in chronological order (video order, then start); a moment is selected only when it shares no
 * footage with the clips selected before it (`sharesFootage`). A moment trimmed to fill the target
 * keeps its original AI times in `aiStart/aiEnd` and its times from before the trim in
 * `autoTrimmedFrom`, so the next run starts from the untrimmed clip again.
 */
export function autoSelect(project: Project): Moment[] {
  const compare = chronologicalComparator(project.videos)
  const moments = project.moments.map(untrim).sort(compare)
  const picker: Picker = { picked: new Set(), trimmed: new Map() }

  const target = project.brief.targetDurationSec
  if (target === null) pickWithoutTarget(moments, picker)
  else pickForTarget(project, target, moments, picker)

  return moments
    .map((moment): Moment => {
      const selected = picker.picked.has(moment.id)
      const trim = picker.trimmed.get(moment.id)
      if (!trim) return { ...moment, selected }
      return {
        ...moment,
        ...trim,
        aiStart: moment.aiStart ?? moment.start,
        aiEnd: moment.aiEnd ?? moment.end,
        autoTrimmedFrom: { start: moment.start, end: moment.end },
        selected
      }
    })
    .sort(compare)
}

/**
 * autoSelect as a store recipe: replaces selection and order of `draft` – the reel is the automatic
 * one again, so the next analysis may rebuild it (`reelEdited` = false).
 */
export function applyAutoSelect(draft: Project): void {
  draft.moments = autoSelect(draft)
  draft.reelEdited = false
}
