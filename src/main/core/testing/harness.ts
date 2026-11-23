// A JobManager wired to a real ProjectStore in a temp dir, fake media/analyzer and recorders.

import type { AppSettings, ExportProgress, Project, ToastEvent } from '@shared/types'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import type { DiskSpace } from '../jobs/diskSpace'
import { JobManager } from '../jobs/manager'
import { createAppPaths, type AppPaths } from '../paths'
import { ProjectStore } from '../project/store'
import { FakeAnalyzer } from './fakeAnalyzer'
import { FakeMedia } from './fakeMedia'
import {
  eventually,
  makeTempDir,
  recordingLogger,
  type RecordingLogger,
  type TempDir
} from './helpers'

export const TEST_API_KEY = 'test-key-123456'
/** local time – export file names use it */
export const TEST_NOW = new Date(2026, 6, 12, 21, 14, 30)

export interface FakeSettings {
  settings: AppSettings
  apiKey: string | null
  /** every reportKeyCheck() call, in order */
  keyChecks: { apiKey: string; accepted: boolean }[]
  getAppSettings(): AppSettings
  getApiKey(): Promise<string | null>
  reportKeyCheck(apiKey: string, accepted: boolean): void
}

/** free space as the jobs see it; null = unknown (no check) */
export interface FakeDisk extends DiskSpace {
  free: number | null
  /** volume of a path (default: everything on one volume) */
  volumes: (path: string) => string
}

export interface Harness {
  temp: TempDir
  paths: AppPaths
  store: ProjectStore
  media: FakeMedia
  analyzer: FakeAnalyzer
  settings: FakeSettings
  disk: FakeDisk
  jobs: JobManager
  log: RecordingLogger
  toasts: ToastEvent[]
  progress: ExportProgress[]
  /** notifications in the order they happened: "toast:<level>", "progress:<phase>", "flush:<id>" */
  timeline: string[]
  outputDir: string
  /** creates an "original" video file (distinct content unless given) the user handed over */
  video(name: string, content?: string): Promise<string>
  /** a project with prepared videos (proxy + sprite done) */
  preparedProject(
    names: string[]
  ): Promise<{ project: Project; videoIds: string[]; files: string[] }>
  dispose(): Promise<void>
}

export async function createHarness(
  // unlimited RAM unless a test is about the memory of the exports
  options: { memoryBytes?: number } = {}
): Promise<Harness> {
  const temp = await makeTempDir('hc-jobs-')
  const paths = createAppPaths(join(temp.path, 'userData'))
  const outputDir = join(temp.path, 'Movies', 'Glimpse')
  const log = recordingLogger()
  let counter = 0
  const newId = (): string => `id${++counter}`
  const store = new ProjectStore({ paths, log, newId, writeDelayMs: 10 })
  await store.init()
  const settings: FakeSettings = {
    settings: {
      model: 'gemini-test',
      hasApiKey: true,
      apiKeySource: 'keychain',
      defaultOutputDir: outputDir,
      fakeAi: false
    },
    apiKey: TEST_API_KEY,
    keyChecks: [],
    getAppSettings: () => settings.settings,
    getApiKey: async () => settings.apiKey,
    reportKeyCheck: (apiKey, accepted) => void settings.keyChecks.push({ apiKey, accepted })
  }
  const media = new FakeMedia()
  const analyzer = new FakeAnalyzer()
  const disk: FakeDisk = {
    free: null,
    volumes: () => 'disk1',
    freeBytes: async () => disk.free,
    volumeId: async (path) => disk.volumes(path)
  }
  const toasts: ToastEvent[] = []
  const progress: ExportProgress[] = []
  const timeline: string[] = []
  const jobs = new JobManager({
    store,
    settings,
    media,
    analyzer,
    paths,
    log,
    disk,
    memoryBytes: options.memoryBytes ?? Number.POSITIVE_INFINITY,
    notify: {
      toast: (event) => {
        toasts.push(event)
        timeline.push(`toast:${event.level}`)
      },
      exportProgress: (event) => {
        progress.push(event)
        timeline.push(`progress:${event.phase}`)
      },
      flushProject: (projectId) => void timeline.push(`flush:${projectId}`)
    },
    now: () => TEST_NOW,
    newId,
    stopTimeoutMs: 2000
  })

  const harness: Harness = {
    temp,
    paths,
    store,
    media,
    analyzer,
    settings,
    disk,
    jobs,
    log,
    toasts,
    progress,
    timeline,
    outputDir,
    async video(name, content) {
      const dir = join(temp.path, 'Originals')
      await mkdir(dir, { recursive: true })
      const path = join(dir, name)
      await writeFile(path, content ?? `video data of ${name}`)
      // as if picked in the dialog: addVideos reads only handed-over files
      jobs.grantPaths([path])
      return path
    },
    async preparedProject(names) {
      const created = await store.create('Festival')
      const files = await Promise.all(names.map((name) => harness.video(name)))
      files.forEach((file, i) =>
        media.probes.set(file, { recordedAt: `2026-07-12T20:0${i}:00.000Z` })
      )
      const result = await jobs.addVideos(created.id, files)
      expect(result.added).toBe(names.length)
      await eventually(() => {
        const project = store.get(created.id)
        expect(project.videos.every((v) => project.status[v.id].prepare.status === 'done')).toBe(
          true
        )
      })
      const project = store.get(created.id)
      return { project, videoIds: project.videos.map((v) => v.id), files }
    },
    async dispose() {
      jobs.cancelAll()
      await jobs.whenIdle()
      await store.close()
      await temp.cleanup()
    }
  }
  return harness
}
