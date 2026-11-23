// Builders for projects, videos and moments in core tests.

import { DEFAULT_BRIEF, DEFAULT_EXPORT_SETTINGS } from '@shared/presets'
import type { Moment, Project, VideoInfo, VideoStatus } from '@shared/types'

export function makeVideo(overrides: Partial<VideoInfo> & { id: string }): VideoInfo {
  return {
    path: `/videos/${overrides.id}.mp4`,
    fileName: `${overrides.id}.mp4`,
    sizeBytes: 50_000_000,
    durationSec: 300,
    width: 1440,
    height: 1920,
    hasAudio: true,
    recordedAt: null,
    fingerprint: `fp-${overrides.id}`,
    proxyPath: null,
    posterPath: null,
    spritePath: null,
    spriteInfo: null,
    ...overrides
  }
}

export function makeMoment(
  overrides: Partial<Moment> & { id: string; videoId: string; start: number; end: number }
): Moment {
  return {
    title: `Moment ${overrides.id}`,
    reason: 'Because it is good.',
    score: 7,
    selected: false,
    aiStart: overrides.start,
    aiEnd: overrides.end,
    ...overrides
  }
}

export function idleStatus(): VideoStatus {
  return {
    prepare: { status: 'pending', progress: 0 },
    analysis: { stage: 'idle', progress: 0 }
  }
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  const videos = overrides.videos ?? []
  const status: Project['status'] = {}
  for (const video of videos) status[video.id] = idleStatus()
  return {
    schemaVersion: 1,
    id: 'p1',
    name: 'Test project',
    createdAt: '2026-07-12T20:00:00.000Z',
    updatedAt: '2026-07-12T20:00:00.000Z',
    videos,
    status: { ...status, ...overrides.status },
    brief: { ...DEFAULT_BRIEF },
    analyses: {},
    remoteFiles: {},
    moments: [],
    reelEdited: false,
    exportSettings: { ...DEFAULT_EXPORT_SETTINGS },
    exports: [],
    ...overrides
  }
}

/** ids of the selected moments in array (= output) order */
export function selectedIds(moments: readonly Moment[]): string[] {
  return moments.filter((m) => m.selected).map((m) => m.id)
}
