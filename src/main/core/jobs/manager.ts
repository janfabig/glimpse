// Facade over the background jobs; the IPC handlers talk to this class only.

import type { StartAnalysisOptions } from '@shared/ipc'
import type { AddVideosResult, Project, RemoteFileRef } from '@shared/types'
import { totalmem } from 'node:os'
import { isAbsolute, normalize } from 'node:path'
import type { Analyzer, MediaService } from '../../contracts'
import { fail } from '../errors'
import { removePath } from '../fsx'
import { newId as defaultNewId } from '../ids'
import type { Logger } from '../log'
import type { AppPaths } from '../paths'
import type { ProjectStore } from '../project/store'
import { applyAutoSelect } from '../selection'
import { AnalysisRunner } from './analysis'
import {
  findVideo,
  requireLiveProject,
  TaskTracker,
  withTimeout,
  type JobContext,
  type JobNotifier,
  type SettingsSource
} from './context'
import { systemDiskSpace, type DiskSpace } from './diskSpace'
import { ExportRunner } from './export'
import { importVideos, type ImportResult } from './importer'
import { JOB_MESSAGES } from './messages'
import { PrepareQueue } from './prepare'
import { deleteRemoteFile } from './remoteFiles'

const MAX_HANDED_OVER = 1000

/** the same folder with or without a trailing slash */
function pathKey(path: string): string {
  return normalize(path).replace(/(?<=.)\/+$/, '')
}

export interface JobManagerOptions {
  store: ProjectStore
  settings: SettingsSource
  media: MediaService
  analyzer: Analyzer
  paths: AppPaths
  notify: JobNotifier
  log: Logger
  /** free-space checks (default: the real file system) */
  disk?: DiskSpace
  /** RAM the exports plan with (default: this Mac's) */
  memoryBytes?: number
  now?: () => Date
  newId?: () => string
  /** how long removals and deletes wait for cancelled jobs to stop (default 8 s) */
  stopTimeoutMs?: number
  /** see TaskTracker: true when the first job starts, false when the last one ends */
  onBusyChange?: (busy: boolean) => void
}

export class JobManager {
  readonly prepare: PrepareQueue
  readonly analysis: AnalysisRunner
  readonly exports: ExportRunner
  private readonly ctx: JobContext
  private readonly stopTimeoutMs: number
  /** deletions in progress – the fence behind ctx.isDeleting; a second delete joins the first */
  private readonly deletions = new Map<string, Promise<void>>()
  /** paths the user handed over (picked or dropped), oldest first – see grantPaths() */
  private readonly handedOver = new Set<string>()

  constructor(options: JobManagerOptions) {
    this.ctx = {
      store: options.store,
      settings: options.settings,
      media: options.media,
      analyzer: options.analyzer,
      paths: options.paths,
      notify: options.notify,
      log: options.log,
      disk: options.disk ?? systemDiskSpace,
      memoryBytes: options.memoryBytes ?? totalmem(),
      now: options.now ?? (() => new Date()),
      newId: options.newId ?? defaultNewId,
      tasks: new TaskTracker(options.onBusyChange),
      isDeleting: (projectId) => this.deletions.has(projectId)
    }
    this.stopTimeoutMs = options.stopTimeoutMs ?? 8000
    this.prepare = new PrepareQueue(this.ctx)
    this.analysis = new AnalysisRunner(this.ctx, this.prepare)
    this.exports = new ExportRunner(this.ctx)
  }

  /** returns the project and queues whatever preparation is still missing */
  async openProject(projectId: string): Promise<Project> {
    await this.prepare.ensureProject(projectId)
    return this.ctx.store.get(projectId)
  }

  /**
   * Files and folders the user handed over: picked in the native dialog or dropped onto the window
   * (the preload reports every path getPathForFile resolves). addVideos lists only such folders –
   * a script in the renderer cannot make main list and import any folder it names.
   */
  grantPaths(paths: readonly string[]): void {
    for (const raw of paths) {
      if (typeof raw !== 'string' || !isAbsolute(raw)) continue
      const key = pathKey(raw)
      this.handedOver.delete(key)
      this.handedOver.add(key)
      // the oldest go first; a session never hands over this many
      if (this.handedOver.size > MAX_HANDED_OVER) {
        this.handedOver.delete(this.handedOver.values().next().value as string)
      }
    }
  }

  async addVideos(projectId: string, paths: readonly string[]): Promise<AddVideosResult> {
    requireLiveProject(this.ctx, projectId)
    const handedOver = (path: string): boolean => this.handedOver.has(pathKey(path))
    let imported: ImportResult
    try {
      // tracked, so deleting the project waits until the posters of this import are written
      imported = await this.ctx.tasks.track(
        projectId,
        importVideos(this.ctx, projectId, paths, handedOver)
      )
    } catch (err) {
      // the delete gave up waiting and removed the folder: drop the posters written after that
      if (!this.ctx.store.find(projectId)) {
        await removePath(this.ctx.paths.projectDir(projectId)).catch(() => undefined)
      }
      throw err
    }
    const { addedIds, ...result } = imported
    for (const videoId of addedIds) void this.prepare.enqueue(projectId, videoId)
    return result
  }

  /** cancels the video's jobs, removes it with its moments and deletes its media folder */
  async removeVideo(projectId: string, videoId: string): Promise<Project> {
    const project = requireLiveProject(this.ctx, projectId)
    if (!findVideo(project, videoId)) fail('not-found', JOB_MESSAGES.videoNotFound)
    this.analysis.cancelVideo(projectId, videoId)
    const stopped = this.prepare.cancelVideo(projectId, videoId)
    const removed: { remote?: RemoteFileRef } = {}
    const next = this.ctx.store.update(projectId, (draft) => {
      removed.remote = draft.remoteFiles[videoId]
      draft.videos = draft.videos.filter((v) => v.id !== videoId)
      draft.moments = draft.moments.filter((m) => m.videoId !== videoId)
      delete draft.status[videoId]
      delete draft.analyses[videoId]
      delete draft.remoteFiles[videoId]
    })
    // an upload reported after this point is deleted by the analysis itself (video gone)
    if (removed.remote) deleteRemoteFile(this.ctx, projectId, removed.remote)
    await withTimeout(stopped, this.stopTimeoutMs)
    await removePath(this.ctx.paths.videoMediaDir(projectId, videoId)).catch((err: unknown) =>
      this.ctx.log.warn('jobs', 'media folder not removed', { projectId, videoId, err })
    )
    return next
  }

  retryPrepare(projectId: string, videoId: string): void {
    this.prepare.retry(projectId, videoId)
  }

  startAnalysis(projectId: string, options?: StartAnalysisOptions): Promise<void> {
    return this.analysis.start(projectId, options)
  }

  /** "Ask Gemini again": `wish` joins the brief and every video is analysed again */
  analyzeAgain(projectId: string, wish: string): Promise<void> {
    return this.analysis.start(projectId, { force: true }, wish)
  }

  cancelAnalysis(projectId: string): void {
    this.ctx.store.get(projectId)
    this.analysis.cancel(projectId)
  }

  /** "Auto-select": replaces selection and order, also of a reel edited by hand */
  autoSelect(projectId: string): Project {
    requireLiveProject(this.ctx, projectId)
    return this.ctx.store.update(projectId, applyAutoSelect)
  }

  startExport(projectId: string): Promise<{ exportId: string }> {
    return this.exports.start(projectId)
  }

  cancelExport(projectId: string): void {
    this.ctx.store.get(projectId)
    this.exports.cancel(projectId)
  }

  /** stops every job of the project, then removes it (incl. media) and its uploads */
  async deleteProject(projectId: string): Promise<void> {
    const running = this.deletions.get(projectId)
    if (running) return running
    this.ctx.store.get(projectId)
    // the fence goes up before the first job is cancelled (stopAndRemove starts a tick later):
    // imports, previews, analyses and exports that are still on their way cannot start new work
    const deletion = Promise.resolve().then(() => this.stopAndRemove(projectId))
    this.deletions.set(projectId, deletion)
    try {
      await deletion
    } finally {
      this.deletions.delete(projectId)
    }
  }

  private async stopAndRemove(projectId: string): Promise<void> {
    this.analysis.cancel(projectId)
    this.exports.cancel(projectId)
    void this.prepare.cancelProject(projectId)
    const stopped = await withTimeout(this.ctx.tasks.settled(projectId), this.stopTimeoutMs)
    if (!stopped) this.ctx.log.warn('jobs', 'jobs still running while deleting', { projectId })
    // read once the jobs have stopped: uploads recorded meanwhile are included. Later reports find
    // the project gone and delete their upload themselves.
    const remotes = Object.values(this.ctx.store.find(projectId)?.remoteFiles ?? {})
    try {
      await this.ctx.store.delete(projectId)
    } finally {
      for (const remote of remotes) deleteRemoteFile(this.ctx, projectId, remote)
    }
    this.ctx.log.info('jobs', 'project deleted', { projectId })
  }

  /** app quit: abort everything (ffmpeg is killed through the abort signals) */
  cancelAll(): void {
    this.analysis.cancelAll()
    this.exports.cancelAll()
    void this.prepare.cancelAll()
  }

  /** an analysis or export runs: quitting would throw it away (previews are redone after a restart) */
  hasUnfinishedWork(): boolean {
    return this.ctx.store
      .all()
      .some((project) => this.analysis.isRunning(project.id) || this.exports.isRunning(project.id))
  }

  /** resolves true once all jobs (and deletes of uploads) have stopped, false on timeout */
  whenIdle(timeoutMs = this.stopTimeoutMs): Promise<boolean> {
    return withTimeout(this.ctx.tasks.settled(), timeoutMs)
  }
}
