// The project stepper: which steps exist, which are reachable and where to land when opening.

import type { Project } from '@shared/types'
import { isAnalysisRunning } from './analysis'

export type StepId = 'videos' | 'brief' | 'analysis' | 'review' | 'export'

export const STEPS: readonly { id: StepId; label: string }[] = [
  { id: 'videos', label: 'Videos' },
  { id: 'brief', label: 'Prompt' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'review', label: 'Edit' },
  { id: 'export', label: 'Export' }
]

/** true once an analysis was started for at least one video */
export function hasAnalysisActivity(project: Project): boolean {
  if (Object.keys(project.analyses).length > 0) return true
  return project.videos.some(
    (video) => (project.status[video.id]?.analysis.stage ?? 'idle') !== 'idle'
  )
}

export function stepAvailability(project: Project): Record<StepId, boolean> {
  const hasVideos = project.videos.length > 0
  return {
    videos: true,
    brief: hasVideos,
    analysis: hasVideos && hasAnalysisActivity(project),
    review: project.moments.length > 0,
    export: project.moments.some((m) => m.selected)
  }
}

/** steps that show a check mark in the stepper */
export function stepCompletion(project: Project): Record<StepId, boolean> {
  const exported = project.exports.length > 0
  return {
    videos: project.videos.length > 0,
    brief: hasAnalysisActivity(project),
    analysis: !isAnalysisRunning(project) && Object.keys(project.analyses).length > 0,
    review: exported,
    export: exported
  }
}

/** where to land when a project is opened */
export function initialStep(project: Project): StepId {
  if (isAnalysisRunning(project)) return 'analysis'
  if (project.moments.length > 0) return 'review'
  return 'videos'
}
