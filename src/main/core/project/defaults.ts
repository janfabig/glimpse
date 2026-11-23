import { DEFAULT_BRIEF, DEFAULT_EXPORT_SETTINGS } from '@shared/presets'
import type { Project, ProjectSummary, VideoStatus } from '@shared/types'

export const SCHEMA_VERSION = 1
export const DEFAULT_PROJECT_NAME = 'New highlight video'

export function createEmptyProject(id: string, name: string, now: string): Project {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    videos: [],
    status: {},
    brief: structuredClone(DEFAULT_BRIEF),
    analyses: {},
    remoteFiles: {},
    moments: [],
    reelEdited: false,
    exportSettings: structuredClone(DEFAULT_EXPORT_SETTINGS),
    exports: []
  }
}

export function initialVideoStatus(): VideoStatus {
  return {
    prepare: { status: 'pending', progress: 0 },
    analysis: { stage: 'idle', progress: 0 }
  }
}

export function summarizeProject(project: Project): ProjectSummary {
  const lastExport = project.exports[project.exports.length - 1]
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    videoCount: project.videos.length,
    totalDurationSec: project.videos.reduce((sum, video) => sum + video.durationSec, 0),
    momentCount: project.moments.length,
    selectedCount: project.moments.filter((m) => m.selected).length,
    posterPath: project.videos.find((video) => video.posterPath)?.posterPath ?? null,
    lastExportPath: lastExport?.path ?? null
  }
}
