// In-memory version of main's applyMutation (docs/ARCHITECTURE.md §5 "Mutations") for the mock API.

import { encodeIpcError } from '@shared/ipc'
import { LIMITS } from '@shared/presets'
import type {
  AspectRatio,
  BriefSettings,
  ExportSettings,
  Moment,
  Project,
  ProjectMutation
} from '@shared/types'
import { clamp, round2 } from '@shared/util'
import { applyAutoSelect, sharesReelFootage, trimBounds } from '../../../main/core/selection'
import { MOCK_MESSAGES } from './mock-messages'

function fail(code: 'invalid' | 'not-found', message: string): never {
  throw new Error(encodeIpcError({ code, message }))
}

function findMoment(project: Project, id: string): Moment {
  return project.moments.find((m) => m.id === id) ?? fail('not-found', 'The clip was not found.')
}

function videoOrder(project: Project): (m: Pick<Moment, 'videoId' | 'start'>) => [number, number] {
  const index = new Map(project.videos.map((v, i) => [v.id, i]))
  return (m) => [index.get(m.videoId) ?? Number.MAX_SAFE_INTEGER, m.start]
}

/** like main's: the hand edits of the reel set Project.reelEdited */
const REEL_MUTATIONS: ReadonlySet<ProjectMutation['type']> = new Set([
  'toggleMoment',
  'updateMomentTimes',
  'resetMomentTimes',
  'reorderMoment'
])

/**
 * main's insertChronologically: each added moment goes right after the closest earlier moment
 * (video order, then start; ties: the last one), else right before the closest later one.
 */
export function insertChronologically(
  project: Project,
  moments: readonly Moment[],
  added: readonly Moment[]
): Moment[] {
  const order = videoOrder(project)
  const compare = (a: Moment, b: Moment): number => {
    const [va, sa] = order(a)
    const [vb, sb] = order(b)
    return va - vb || sa - sb
  }
  const result = [...moments]
  for (const moment of [...added].sort(compare)) {
    let previous = -1
    let next = -1
    result.forEach((m, i) => {
      if (compare(m, moment) <= 0) {
        if (previous < 0 || compare(m, result[previous]) >= 0) previous = i
      } else if (next < 0 || compare(m, result[next]) < 0) {
        next = i
      }
    })
    result.splice(previous >= 0 ? previous + 1 : next >= 0 ? next : result.length, 0, moment)
  }
  return result
}

function normaliseBrief(brief: BriefSettings): BriefSettings {
  const target =
    brief.targetDurationSec === null
      ? null
      : clamp(brief.targetDurationSec, LIMITS.targetDurationSec.min, LIMITS.targetDurationSec.max)
  return { ...brief, targetDurationSec: target }
}

const ASPECTS: AspectRatio[] = ['source', '9:16', '4:5', '1:1', '16:9']

function normaliseExport(settings: ExportSettings): ExportSettings {
  if (!ASPECTS.includes(settings.aspect)) fail('invalid', 'Unknown format.')
  return settings
}

export function applyMockMutation(source: Project, mutation: ProjectMutation): Project {
  const project = structuredClone(source)
  switch (mutation.type) {
    case 'rename': {
      const name = mutation.name.trim()
      if (name.length < 1 || name.length > 80) {
        fail('invalid', 'The name must be 1 to 80 characters long.')
      }
      project.name = name
      break
    }
    case 'setBrief': {
      const target = project.brief.targetDurationSec
      project.brief = normaliseBrief({ ...project.brief, ...mutation.patch })
      // like main: an automatic reel follows its target length, one edited by hand stays
      const retarget = project.brief.targetDurationSec !== target && !project.reelEdited
      if (retarget) applyAutoSelect(project)
      break
    }
    case 'setExportSettings':
      project.exportSettings = normaliseExport({ ...project.exportSettings, ...mutation.patch })
      break
    case 'toggleMoment': {
      const moment = findMoment(project, mutation.momentId)
      if (mutation.selected && !moment.selected && sharesReelFootage(project.moments, moment)) {
        fail('invalid', MOCK_MESSAGES.footageTwice)
      }
      moment.selected = mutation.selected
      break
    }
    case 'updateMomentTimes': {
      const moment = findMoment(project, mutation.momentId)
      const video = project.videos.find((v) => v.id === moment.videoId)
      // like main: inside the video, and up to the neighbours in the highlight video
      const { min, max } = trimBounds(
        moment,
        project.moments,
        video?.durationSec ?? Number.MAX_SAFE_INTEGER
      )
      const start = clamp(round2(mutation.start), min, max)
      const end = clamp(round2(mutation.end), min, max)
      if (end - start < LIMITS.minMomentSec) {
        fail('invalid', 'A clip must be at least 0.5 s long.')
      }
      // like main: the times it already has are no edit of the reel
      if (start === moment.start && end === moment.end) return project
      moment.start = start
      moment.end = end
      delete moment.autoTrimmedFrom
      break
    }
    case 'resetMomentTimes': {
      const moment = findMoment(project, mutation.momentId)
      delete moment.autoTrimmedFrom
      if (moment.aiStart !== undefined && moment.aiEnd !== undefined) {
        const ai = { start: moment.aiStart, end: moment.aiEnd }
        if (moment.selected && sharesReelFootage(project.moments, moment, ai)) {
          fail('invalid', MOCK_MESSAGES.footageTwice)
        }
        moment.start = moment.aiStart
        moment.end = moment.aiEnd
      }
      break
    }
    case 'reorderMoment': {
      const moved = findMoment(project, mutation.momentId)
      const rest = project.moments.filter((m) => m.id !== moved.id)
      const selected = rest.filter((m) => m.selected)
      let insertAt: number
      if (mutation.toIndex >= selected.length) {
        const last = selected[selected.length - 1]
        insertAt = last ? rest.indexOf(last) + 1 : rest.length
      } else {
        insertAt = rest.indexOf(selected[Math.max(0, mutation.toIndex)])
      }
      rest.splice(insertAt, 0, moved)
      project.moments = rest
      break
    }
  }
  if (REEL_MUTATIONS.has(mutation.type)) project.reelEdited = true
  return project
}
