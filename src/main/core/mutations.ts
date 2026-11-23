// Pure project mutations requested by the renderer (docs/ARCHITECTURE.md §5 "Mutations").
// Every field is validated here – the IPC layer only checks the envelope.

import { LIMITS } from '@shared/presets'
import type { Moment, Project, ProjectMutation, VideoInfo } from '@shared/types'
import { clamp, isRecord, round2 } from '@shared/util'
import { fail } from './errors'
import { isFiniteNumber, mergeBrief, mergeExportSettings } from './project/sanitize'
import { applyAutoSelect, sharesReelFootage, trimBounds } from './selection'

export const MAX_NAME_LENGTH = 80

const MIN_MOMENT_LABEL = String(LIMITS.minMomentSec)

/**
 * Hand edits of the reel (selection, order, trims). They set `reelEdited`, so the next
 * analysis keeps the reel instead of re-selecting it automatically.
 */
export const REEL_MUTATIONS: ReadonlySet<ProjectMutation['type']> = new Set([
  'toggleMoment',
  'updateMomentTimes',
  'resetMomentTimes',
  'reorderMoment'
])

export const MUTATION_MESSAGES = {
  unknown: 'This change is not supported.',
  nameLength: `The name must be 1 to ${MAX_NAME_LENGTH} characters long.`,
  momentNotFound: 'The clip was not found.',
  videoNotFound: 'The video was not found.',
  tooShort: `A clip must be at least ${MIN_MOMENT_LABEL} s long.`,
  footageTwice:
    'This part is already in another clip in the highlight video. ' +
    'Trim one of the two clips or remove the other one.',
  invalidValue: (label: string): string => `Invalid value for “${label}”.`
} as const

function requireNumber(value: unknown, label: string): number {
  if (!isFiniteNumber(value)) fail('invalid', MUTATION_MESSAGES.invalidValue(label))
  return value
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail('invalid', MUTATION_MESSAGES.invalidValue(label))
  return value
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') fail('invalid', MUTATION_MESSAGES.invalidValue(label))
  return value
}

function findMoment(project: Project, momentId: unknown): Moment {
  const moment =
    typeof momentId === 'string' ? project.moments.find((m) => m.id === momentId) : undefined
  return moment ?? fail('not-found', MUTATION_MESSAGES.momentNotFound)
}

function findVideo(project: Project, videoId: unknown): VideoInfo {
  const video =
    typeof videoId === 'string' ? project.videos.find((v) => v.id === videoId) : undefined
  return video ?? fail('not-found', MUTATION_MESSAGES.videoNotFound)
}

/** clamps to the clip's room (trimBounds) on a 0.01 s grid and enforces the minimum clip length */
export function fitMomentTimes(
  start: number,
  end: number,
  bounds: { min: number; max: number }
): { start: number; end: number } {
  const s = clamp(round2(start), bounds.min, bounds.max)
  const e = clamp(round2(end), bounds.min, bounds.max)
  if (e - s < LIMITS.minMomentSec - 1e-9) fail('invalid', MUTATION_MESSAGES.tooShort)
  return { start: s, end: e }
}

/**
 * Moves `moved` so that it ends up at `toIndex` among the selected moments (counted after removing
 * it): just before the selected moment currently at that position, or after the last selected one.
 */
function reorder(moments: Moment[], moved: Moment, toIndex: number): Moment[] {
  const rest = moments.filter((m) => m !== moved)
  const selected = rest.filter((m) => m.selected)
  if (selected.length === 0) return moments
  const insertAt =
    toIndex >= selected.length
      ? rest.indexOf(selected[selected.length - 1]) + 1
      : rest.indexOf(selected[toIndex])
  rest.splice(insertAt, 0, moved)
  return rest
}

/** Applies one mutation to a copy of `source`. Throws a CoreError (invalid / not-found). */
export function applyMutation(source: Project, mutation: ProjectMutation): Project {
  if (!isRecord(mutation) || typeof mutation.type !== 'string') {
    fail('invalid', MUTATION_MESSAGES.unknown)
  }
  const project = structuredClone(source)

  switch (mutation.type) {
    case 'rename': {
      const name = requireString(mutation.name, 'Name').trim()
      if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
        fail('invalid', MUTATION_MESSAGES.nameLength)
      }
      project.name = name
      break
    }
    case 'setBrief': {
      const target = project.brief.targetDurationSec
      project.brief = mergeBrief(project.brief, mutation.patch, 'strict')
      // an automatic reel follows its target length; one edited by hand stays as the user left it
      const retarget = project.brief.targetDurationSec !== target && !project.reelEdited
      if (retarget) applyAutoSelect(project)
      break
    }
    case 'setExportSettings':
      project.exportSettings = mergeExportSettings(project.exportSettings, mutation.patch, 'strict')
      break
    case 'toggleMoment': {
      const moment = findMoment(project, mutation.momentId)
      const selected = requireBoolean(mutation.selected, 'Selection')
      // like the automatic selection: the clip that is in already wins
      if (selected && !moment.selected && sharesReelFootage(project.moments, moment)) {
        fail('invalid', MUTATION_MESSAGES.footageTwice)
      }
      moment.selected = selected
      break
    }
    case 'updateMomentTimes': {
      const moment = findMoment(project, mutation.momentId)
      const video = findVideo(project, moment.videoId)
      const times = fitMomentTimes(
        requireNumber(mutation.start, 'Start'),
        requireNumber(mutation.end, 'End'),
        trimBounds(moment, project.moments, video.durationSec)
      )
      // the times it already has (e.g. a trim key held at a limit) are no edit of the reel
      if (times.start === moment.start && times.end === moment.end) return project
      moment.start = times.start
      moment.end = times.end
      // the user's own trim – autoSelect must not undo it
      delete moment.autoTrimmedFrom
      break
    }
    case 'resetMomentTimes': {
      const moment = findMoment(project, mutation.momentId)
      delete moment.autoTrimmedFrom
      // a clip of an older version may have no AI times – nothing to reset
      if (moment.aiStart !== undefined && moment.aiEnd !== undefined) {
        const ai = { start: moment.aiStart, end: moment.aiEnd }
        if (moment.selected && sharesReelFootage(project.moments, moment, ai)) {
          fail('invalid', MUTATION_MESSAGES.footageTwice)
        }
        moment.start = moment.aiStart
        moment.end = moment.aiEnd
      }
      break
    }
    case 'reorderMoment': {
      const moved = findMoment(project, mutation.momentId)
      const toIndex = requireNumber(mutation.toIndex, 'Position')
      if (!Number.isInteger(toIndex) || toIndex < 0) {
        fail('invalid', MUTATION_MESSAGES.invalidValue('Position'))
      }
      project.moments = reorder(project.moments, moved, toIndex)
      break
    }
    default:
      fail('invalid', MUTATION_MESSAGES.unknown)
  }

  if (REEL_MUTATIONS.has(mutation.type)) project.reelEdited = true
  return project
}
