// "Ask Gemini again" in the Edit step (docs/ARCHITECTURE.md §5 Jobs, "Second pass"): when the
// button works and what its dialog says.

import { LIMITS } from '@shared/presets'
import { wishProblem } from '@shared/second-pass'
import type { AppSettings, Project } from '@shared/types'
import { isAnalysisRunning } from './analysis'
import { freeQuotaWarning } from './cost'

/** why the run cannot start right now (the button's tooltip) – null: it can */
export function againBlocker(project: Project, settings: AppSettings | null): string | null {
  if (isAnalysisRunning(project)) return 'The analysis is running.'
  if (project.videos.length === 0) return 'Add videos first.'
  if (settings && !settings.hasApiKey && !settings.fakeAi) {
    return 'Connect Gemini first in Settings.'
  }
  return null
}

export interface AgainDialog {
  /** what the run does */
  intro: string
  /** what it replaces */
  consequence: string
  /**
   * the Prompt step's free-quota warning, when the daily quota is too small for analysing every
   * video on top of the analyses of the last 24 hours
   */
  quotaWarning: string | null
  /** the note does not fit into the prompt any more */
  tooLong: string | null
  canStart: boolean
}

export function againDialog(
  project: Project,
  settings: AppSettings | null,
  wish: string,
  now: number = Date.now()
): AgainDialog {
  const videos = project.videos.length
  // a second pass usually follows the first one on the same day, out of the same daily quota
  const usedToday = Object.values(project.analyses).filter(
    (analysis) => now - Date.parse(analysis.createdAt) < 24 * 3600 * 1000
  ).length
  const problem = wishProblem(project.brief.prompt, wish)
  return {
    intro:
      (videos === 1
        ? 'Gemini looks at your video again, with one request.'
        : `Gemini looks at all ${videos} videos again, one request per video.`) +
      ' Your note is added as a new line at the end of your prompt and stays there.',
    consequence:
      'Everything Gemini has suggested so far is replaced, and your changes to those clips are lost. After that, your highlight video is put together again.',
    quotaWarning: freeQuotaWarning(settings?.model, videos + usedToday),
    tooLong:
      problem === 'too-long'
        ? `Your note no longer fits into your prompt (together at most ${LIMITS.promptMax.toLocaleString('en-GB')} characters). Shorten it or your prompt.`
        : null,
    canStart: problem === null && againBlocker(project, settings) === null
  }
}
