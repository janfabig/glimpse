// Pure helpers around moments (clips): lengths, trimming and reordering.

import { EXPORT_FIXED } from '@shared/presets'
import { formatDurationDe } from '@shared/time'
import type { ExportSettings, Moment, MomentId, Project } from '@shared/types'
import { clamp, round2 } from '@shared/util'

export interface TimeRange {
  start: number
  end: number
}

export function rangeLength(range: TimeRange): number {
  return Math.max(0, range.end - range.start)
}

/**
 * Length of the finished reel: crossfades overlap neighbouring clips
 * (same formula as the automatic selection in main).
 */
export function effectiveLength(
  ranges: TimeRange[],
  settings: Pick<ExportSettings, 'transition'>
): number {
  if (ranges.length === 0) return 0
  const overlap = settings.transition === 'crossfade' ? EXPORT_FIXED.crossfadeSec : 0
  const sum = ranges.reduce((acc, range) => acc + rangeLength(range), 0)
  return Math.max(0, sum - overlap * (ranges.length - 1))
}

/**
 * Converts a drop slot in the list of selected clips (0..count, "insert before the clip at
 * slot") into the `toIndex` of the reorderMoment mutation, which is the position among the
 * selected clips after removing the moved one. Returns null when the clip would not move.
 */
export function reorderTarget(fromIndex: number, slot: number, count: number): number | null {
  const clamped = clamp(slot, 0, count)
  const toIndex = clamped > fromIndex ? clamped - 1 : clamped
  return toIndex === fromIndex ? null : toIndex
}

export type LengthState = 'free' | 'under' | 'fits' | 'over'

export interface LengthStatus {
  state: LengthState
  total: number
  target: number | null
  /** total - target (seconds) */
  delta: number
}

/** compares the reel length with the brief's target (tolerance as in the automatic selection) */
export function lengthStatus(total: number, target: number | null): LengthStatus {
  if (target === null) return { state: 'free', total, target, delta: 0 }
  const tolerance = Math.max(2, 0.08 * target)
  const delta = total - target
  const state: LengthState = Math.abs(delta) <= tolerance ? 'fits' : delta > 0 ? 'over' : 'under'
  return { state, total, target, delta }
}

/** rows of “More suggestions” */
export const SUGGESTION_LIMIT = 10

/**
 * “More suggestions”: the best clips that are not in the highlight video, best first (score, then
 * the shorter one, then video order). `keepId` – the clip shown in the editor – keeps its place:
 * also below the best ones, and when X just took it into the highlight video.
 */
export function suggestions(project: Project, keepId?: MomentId): Moment[] {
  const ranked = project.videos
    .flatMap((video) =>
      project.moments
        .filter((m) => m.videoId === video.id && (!m.selected || m.id === keepId))
        .sort((a, b) => a.start - b.start)
    )
    .sort((a, b) => b.score - a.score || rangeLength(a) - rangeLength(b))
  const best = new Set(ranked.filter((m) => !m.selected).slice(0, SUGGESTION_LIMIT))
  return ranked.filter((m) => best.has(m) || m.id === keepId)
}

/**
 * Confirmation text before "Auto-select" replaces a reel the user edited by hand:
 * main re-selects for the target length and sorts chronologically; trims stay.
 */
export function describeAutoSelect(project: Pick<Project, 'brief'>): string {
  const target = project.brief.targetDurationSec
  return (
    (target === null
      ? 'Glimpse selects all strong moments again.'
      : `Glimpse selects the best moments again to match the target length of ${formatDurationDe(target)}.`) +
    ' Your selection and the order of the clips are replaced. Your trims are kept.'
  )
}

/** the room a trim may use: `trimBounds` of main's selection.ts, which main clamps to as well */
export interface TrimRoom {
  min: number
  max: number
}

/**
 * Sets the in point to `t`. When `t` lies at or behind the out point the clip keeps its length
 * and moves along, so "set start here" always does something sensible.
 */
export function withInPoint(
  range: TimeRange,
  t: number,
  room: TrimRoom,
  minLength: number
): TimeRange {
  const start = clamp(t, room.min, Math.max(room.min, room.max - minLength))
  let end = range.end
  if (end - start < minLength) {
    end = Math.min(room.max, start + Math.max(rangeLength(range), minLength))
  }
  return { start: round2(start), end: round2(end) }
}

/** counterpart of withInPoint for the out point */
export function withOutPoint(
  range: TimeRange,
  t: number,
  room: TrimRoom,
  minLength: number
): TimeRange {
  const end = clamp(t, Math.min(room.min + minLength, room.max), room.max)
  let start = range.start
  if (end - start < minLength) {
    start = Math.max(room.min, end - Math.max(rangeLength(range), minLength))
  }
  return { start: round2(start), end: round2(end) }
}

/** moves one edge to `t` (handle drag, arrow keys, −/+): clamps the moved edge only */
export function dragEdge(
  range: TimeRange,
  edge: 'start' | 'end',
  t: number,
  room: TrimRoom,
  minLength: number
): TimeRange {
  if (edge === 'start') {
    return { start: round2(clamp(t, room.min, range.end - minLength)), end: range.end }
  }
  return { start: range.start, end: round2(clamp(t, range.start + minLength, room.max)) }
}

/** where to play an edited clip from, so the edit is heard: its start, or 2 s before its end */
export function editPoint(range: TimeRange, edge: 'start' | 'end'): number {
  return edge === 'start' ? range.start : Math.max(range.start, range.end - 2)
}

/** visible window around a clip: the clip plus generous context on both sides (≥ 24 s) */
export function zoomWindow(range: TimeRange, durationSec: number): TimeRange {
  const length = range.end - range.start
  const span = Math.min(durationSec, Math.max(24, length * 3.2))
  const centre = (range.start + range.end) / 2
  const start = Math.min(Math.max(0, centre - span / 2), Math.max(0, durationSec - span))
  return { start, end: start + span }
}
