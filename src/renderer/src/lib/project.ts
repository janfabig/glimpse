// Derived project data shared by the store and the screens.

import type { Project, ProjectSummary, VideoInfo } from '@shared/types'
import { plural } from './format'

/** same shape main returns from listProjects() */
export function summarize(project: Project): ProjectSummary {
  const last = project.exports[project.exports.length - 1]
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    videoCount: project.videos.length,
    totalDurationSec: project.videos.reduce((sum, video) => sum + video.durationSec, 0),
    momentCount: project.moments.length,
    selectedCount: project.moments.filter((m) => m.selected).length,
    posterPath: project.videos[0]?.posterPath ?? null,
    lastExportPath: last?.path ?? null
  }
}

/** replaces the summary of `project` in the list (keeps list order by last change) */
export function upsertSummary(list: ProjectSummary[], project: Project): ProjectSummary[] {
  const summary = summarize(project)
  const rest = list.filter((entry) => entry.id !== project.id)
  return [summary, ...rest].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/**
 * confirmation text before removing a video that has moments:
 * "“VID.mp4” has 2 clips in your highlight video …"
 */
export function videoRemovalMessage(project: Pick<Project, 'moments'>, video: VideoInfo): string {
  const own = project.moments.filter((m) => m.videoId === video.id)
  const inReel = own.filter((m) => m.selected).length
  const others = own.length - inReel
  const parts = [
    inReel > 0 && `${plural(inReel, 'clip', 'clips')} in your highlight video`,
    others > 0 && plural(others, 'more suggestion', 'more suggestions')
  ].filter(Boolean)
  const subject = own.length === 1 ? 'It disappears' : 'They disappear'
  return (
    `“${video.fileName}” has ${parts.join(' and ')}. ${subject} from the project together with ` +
    'the video. The original file is kept.'
  )
}

/**
 * The preparation failed because the original file is gone (main: "The original file “…” was not
 * found. …"): trying again only helps once the file is back – removing the video is the other way
 * out. Main turns the text a German build stored into this one when it loads the project.
 */
export function isMissingOriginal(prepareError: string | undefined): boolean {
  return /^The (?:original file|file) “.+” was not found/.test(prepareError?.trim() ?? '')
}
