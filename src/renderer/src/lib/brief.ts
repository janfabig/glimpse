// The Prompt step: target length options and what the next analysis run would do.

import { TARGET_DURATION_OPTIONS } from '@shared/presets'
import type { Project } from '@shared/types'
import { previewFailed } from './analysis'
import { isAnalysisFresh } from './brief-hash'

/** "30 s", "1 min", "1:30 min", "No limit" – every target length reads the same way */
export function formatTargetLabel(sec: number | null): string {
  if (sec === null) return 'No limit'
  const total = Math.max(0, Math.round(sec))
  if (total < 60) return `${total} s`
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return rest === 0 ? `${minutes} min` : `${minutes}:${String(rest).padStart(2, '0')} min`
}

/** the target options in order; a length from elsewhere (an older project) takes its sorted place */
export function targetOptions(current: number | null): (number | null)[] {
  const values = TARGET_DURATION_OPTIONS.filter((value): value is number => value !== null)
  if (current !== null && !values.includes(current)) values.push(current)
  values.sort((a, b) => a - b)
  return [...values, null]
}

export interface AnalysisPlan {
  /** videos the next run analyses with Gemini (no fresh result for this brief and model) */
  toAnalyse: number
  /** of those, videos with a result of another prompt or model */
  stale: number
  /** videos with a fresh result */
  fresh: number
  /** videos without a fresh result whose preview failed: main fails them right away */
  withoutPreview: number
}

/**
 * What "Analyse with Gemini" would do. Without the current brief hash (still computing) every
 * video counts as to be analysed. Videos whose preview failed are left out of the count and the
 * time estimate – they never reach Gemini.
 */
export function analysisPlan(project: Project, currentHash: string | null): AnalysisPlan {
  const plan: AnalysisPlan = { toAnalyse: 0, stale: 0, fresh: 0, withoutPreview: 0 }
  for (const video of project.videos) {
    if (currentHash !== null && isAnalysisFresh(project, video.id, currentHash)) {
      plan.fresh++
    } else if (previewFailed(project, video.id)) {
      plan.withoutPreview++
    } else {
      plan.toAnalyse++
      // outdated means another prompt or model; a failed re-run with the same ones is not
      const analysis = project.analyses[video.id]
      if (currentHash !== null && analysis && analysis.briefHash !== currentHash) plan.stale++
    }
  }
  return plan
}
