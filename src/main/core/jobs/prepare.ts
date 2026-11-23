// Background preparation of every video: poster (if missing) → 720p proxy → filmstrip sprite.
// One global queue; analysis awaits the proxy of a video through waitForProxy() and then makes
// the copy it uploads (ensureAnalysisCopy).

import type { VideoInfo, VideoStatus } from '@shared/types'
import { mkdir, stat } from 'node:fs/promises'
import { deferred, type Deferred } from '../deferred'
import { CoreError, isCancellation, userMessage } from '../errors'
import { isFile } from '../fsx'
import {
  abortable,
  abortError,
  findVideo,
  isLive,
  requireLiveProject,
  throttledProgress,
  throwIfAborted,
  updateVideo,
  type JobContext
} from './context'
import { ensureFreeSpace, estimateProxyBytes } from './diskSpace'
import { JOB_MESSAGES } from './messages'

type Outcome = 'done' | 'error' | 'cancelled'

interface PrepareJob {
  key: string
  projectId: string
  videoId: string
  controller: AbortController
  outcome: Deferred<Outcome>
  /** set when the job has ended */
  result: Outcome | null
  /** resolves once the proxy exists (or the job ended) – analysis can start before the sprite */
  proxyReady: Deferred<void>
}

/** share of the prepare progress bar that belongs to the proxy (the sprite is the rest) */
const PROXY_SHARE = 0.9
/** proxy/sprite renders at a time, over all projects */
const PREPARE_PARALLEL = 2

/** the video has no preview and its preparation failed: there is nothing to analyse */
export class PreviewMissingError extends CoreError {
  constructor(reason?: string) {
    super('internal', JOB_MESSAGES.previewMissing(reason))
    this.name = 'PreviewMissingError'
  }
}

/** frame used as poster: a little into the clip, away from black first frames */
export function posterTime(durationSec: number): number {
  return Math.min(2, durationSec / 4)
}

export class PrepareQueue {
  private readonly ctx: JobContext
  private readonly waiting: PrepareJob[] = []
  private readonly running = new Set<PrepareJob>()
  private readonly jobs = new Map<string, PrepareJob>()

  constructor(ctx: JobContext) {
    this.ctx = ctx
  }

  isQueued(projectId: string, videoId: string): boolean {
    return this.jobs.has(jobKey(projectId, videoId))
  }

  /** queues the video (no-op when it is already queued or running, or the project is going away) */
  enqueue(projectId: string, videoId: string): Promise<Outcome> {
    const key = jobKey(projectId, videoId)
    const existing = this.jobs.get(key)
    if (existing) return existing.outcome.promise
    if (!isLive(this.ctx, projectId)) return Promise.resolve('cancelled')
    const job: PrepareJob = {
      key,
      projectId,
      videoId,
      controller: new AbortController(),
      outcome: deferred<Outcome>(),
      result: null,
      proxyReady: deferred<void>()
    }
    this.jobs.set(key, job)
    this.waiting.push(job)
    this.ctx.tasks.track(projectId, job.outcome.promise)
    this.pump()
    return job.outcome.promise
  }

  /** moves a waiting video to the front (analysis is waiting for it) */
  prioritize(projectId: string, videoId: string): void {
    const index = this.waiting.findIndex((job) => job.key === jobKey(projectId, videoId))
    if (index > 0) this.waiting.unshift(...this.waiting.splice(index, 1))
  }

  /** resets a failed (or unfinished) preparation and queues it again */
  retry(projectId: string, videoId: string): void {
    const project = requireLiveProject(this.ctx, projectId)
    const video = findVideo(project, videoId)
    if (!video) throw new CoreError('not-found', JOB_MESSAGES.videoNotFound)
    if (this.isQueued(projectId, videoId)) return
    const status = project.status[videoId]?.prepare.status
    if (status === 'done' && video.proxyPath && video.spritePath) return
    this.setPrepare(projectId, videoId, { status: 'pending', progress: 0 })
    void this.enqueue(projectId, videoId)
  }

  /**
   * On opening a project: forgets media files that vanished and queues every video whose
   * preparation is pending or incomplete (failed ones wait for an explicit retry).
   */
  async ensureProject(projectId: string): Promise<void> {
    const project = requireLiveProject(this.ctx, projectId)
    const exists = (path: string | null): Promise<boolean> =>
      path ? isFile(path) : Promise.resolve(true)
    for (const video of project.videos) {
      if (this.isQueued(projectId, video.id)) continue
      const [poster, proxy, sprite] = await Promise.all(
        [video.posterPath, video.proxyPath, video.spritePath].map(exists)
      )
      const status = project.status[video.id]?.prepare.status ?? 'pending'
      const lost = !poster || !proxy || !sprite
      const redo = status === 'done' && (lost || !video.proxyPath || !video.spritePath)
      if (lost || redo) {
        updateVideo(this.ctx, projectId, video.id, (draft, v) => {
          if (!poster) v.posterPath = null
          if (!proxy) v.proxyPath = null
          if (!sprite) {
            v.spritePath = null
            v.spriteInfo = null
          }
          if (redo) draft.status[v.id].prepare = { status: 'pending', progress: 0 }
        })
      }
      if (status === 'pending' || redo) void this.enqueue(projectId, video.id)
    }
  }

  /** resolves with the proxy path once it exists; throws when the preparation failed */
  async waitForProxy(projectId: string, videoId: string, signal: AbortSignal): Promise<string> {
    for (let round = 0; round < 3; round++) {
      throwIfAborted(signal)
      const project = this.ctx.store.find(projectId)
      const video = findVideo(project, videoId)
      if (!project || !video) throw abortError()
      if (video.proxyPath && (await isFile(video.proxyPath))) return video.proxyPath
      if (video.proxyPath) {
        updateVideo(this.ctx, projectId, videoId, (draft, v) => {
          v.proxyPath = null
          draft.status[v.id].prepare = { status: 'pending', progress: 0 }
        })
      }
      const prepare = this.ctx.store.find(projectId)?.status[videoId]?.prepare
      if (prepare?.status === 'error' && !this.isQueued(projectId, videoId)) {
        throw new PreviewMissingError(prepare.error)
      }
      void this.enqueue(projectId, videoId)
      this.prioritize(projectId, videoId)
      const job = this.jobs.get(jobKey(projectId, videoId))
      if (!job) continue
      await abortable(job.proxyReady.promise, signal)
      if (job.result === 'cancelled') throw abortError()
    }
    throw new PreviewMissingError()
  }

  /**
   * The lean copy of the proxy that Gemini gets (720p, 4 fps, mono): made on first use and again
   * when the proxy is newer. Runs inside the analysis job, so its signal stops it.
   */
  async ensureAnalysisCopy(
    projectId: string,
    video: VideoInfo,
    proxyPath: string,
    signal: AbortSignal,
    onMake: () => void
  ): Promise<string> {
    const path = this.ctx.paths.analysisFile(projectId, video.id)
    const [copy, proxy] = await Promise.all([stat(path).catch(() => null), stat(proxyPath)])
    if (copy?.isFile() && copy.mtimeMs >= proxy.mtimeMs) return path
    onMake()
    // the copy is smaller than the proxy, so the proxy's estimate covers it
    await ensureFreeSpace(this.ctx, [
      {
        path: this.ctx.paths.videoMediaDir(projectId, video.id),
        bytes: estimateProxyBytes(video.durationSec)
      }
    ])
    await this.ctx.media.makeAnalysisCopy(proxyPath, path, { signal })
    return path
  }

  cancelVideo(projectId: string, videoId: string): Promise<void> {
    return this.cancelWhere((job) => job.projectId === projectId && job.videoId === videoId)
  }

  cancelProject(projectId: string): Promise<void> {
    return this.cancelWhere((job) => job.projectId === projectId)
  }

  cancelAll(): Promise<void> {
    return this.cancelWhere(() => true)
  }

  /** aborts matching jobs; resolves once they have stopped */
  private cancelWhere(match: (job: PrepareJob) => boolean): Promise<void> {
    const affected = [...this.jobs.values()].filter(match)
    for (const job of affected) {
      job.controller.abort()
      const index = this.waiting.indexOf(job)
      if (index >= 0) {
        this.waiting.splice(index, 1)
        this.finish(job, 'cancelled')
      }
    }
    return Promise.all(affected.map((job) => job.outcome.promise)).then(() => undefined)
  }

  private pump(): void {
    while (this.running.size < PREPARE_PARALLEL && this.waiting.length > 0) {
      const job = this.waiting.shift() as PrepareJob
      this.running.add(job)
      void this.run(job).then((outcome) => {
        this.running.delete(job)
        this.finish(job, outcome)
        this.pump()
      })
    }
  }

  private finish(job: PrepareJob, outcome: Outcome): void {
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key)
    job.result = outcome
    job.proxyReady.resolve()
    job.outcome.resolve(outcome)
  }

  private setPrepare(
    projectId: string,
    videoId: string,
    prepare: VideoStatus['prepare'],
    persist = true
  ): void {
    updateVideo(
      this.ctx,
      projectId,
      videoId,
      (draft) => {
        draft.status[videoId] = { ...draft.status[videoId], prepare }
      },
      { persist }
    )
  }

  /** never rejects */
  private async run(job: PrepareJob): Promise<Outcome> {
    const { projectId, videoId } = job
    const { signal } = job.controller
    const video = findVideo(this.ctx.store.find(projectId), videoId)
    if (!video || signal.aborted) return 'cancelled'
    this.setPrepare(projectId, videoId, { status: 'running', progress: 0 })
    try {
      await mkdir(this.ctx.paths.videoMediaDir(projectId, videoId), { recursive: true })
      await this.ensurePoster(projectId, video)
      const proxyPath = await this.ensureProxy(projectId, video, signal)
      job.proxyReady.resolve()
      throwIfAborted(signal)
      await this.ensureSprite(projectId, video, proxyPath, signal)
      this.setPrepare(projectId, videoId, { status: 'done', progress: 1 })
      return 'done'
    } catch (err) {
      if (isCancellation(err, signal)) {
        this.setPrepare(projectId, videoId, { status: 'pending', progress: 0 })
        return 'cancelled'
      }
      this.ctx.log.warn('prepare', 'preparing a video failed', { projectId, videoId, err })
      const error = userMessage(err, JOB_MESSAGES.prepareFailed)
      this.setPrepare(projectId, videoId, { status: 'error', progress: 0, error })
      return 'error'
    }
  }

  /** best effort: a missing poster only means a placeholder in the UI */
  private async ensurePoster(projectId: string, video: VideoInfo): Promise<void> {
    if (video.posterPath && (await isFile(video.posterPath))) return
    const posterPath = this.ctx.paths.posterFile(projectId, video.id)
    try {
      await this.ctx.media.makePoster(video.path, posterPath, posterTime(video.durationSec))
      updateVideo(this.ctx, projectId, video.id, (_draft, v) => {
        v.posterPath = posterPath
      })
    } catch (err) {
      this.ctx.log.warn('prepare', 'poster failed', { projectId, videoId: video.id, err })
    }
  }

  private async ensureProxy(
    projectId: string,
    video: VideoInfo,
    signal: AbortSignal
  ): Promise<string> {
    if (video.proxyPath && (await isFile(video.proxyPath))) return video.proxyPath
    if (!(await isFile(video.path))) {
      throw new CoreError('not-found', JOB_MESSAGES.missingOriginal(video.fileName))
    }
    const proxyPath = this.ctx.paths.proxyFile(projectId, video.id)
    // a full disk is reported now instead of ffmpeg failing halfway
    await ensureFreeSpace(this.ctx, [
      {
        path: this.ctx.paths.videoMediaDir(projectId, video.id),
        bytes: estimateProxyBytes(video.durationSec)
      }
    ])
    const onProgress = throttledProgress((fraction) =>
      this.setPrepare(
        projectId,
        video.id,
        { status: 'running', progress: fraction * PROXY_SHARE },
        false
      )
    )
    await this.ctx.media.makeProxy(video.path, proxyPath, {
      durationSec: video.durationSec,
      onProgress,
      signal
    })
    updateVideo(this.ctx, projectId, video.id, (draft, v) => {
      v.proxyPath = proxyPath
      draft.status[v.id].prepare = { status: 'running', progress: PROXY_SHARE }
    })
    return proxyPath
  }

  private async ensureSprite(
    projectId: string,
    video: VideoInfo,
    proxyPath: string,
    signal: AbortSignal
  ): Promise<void> {
    if (video.spritePath && video.spriteInfo && (await isFile(video.spritePath))) return
    const spritePath = this.ctx.paths.spriteFile(projectId, video.id)
    const spriteInfo = await this.ctx.media.makeSprite(proxyPath, spritePath, {
      durationSec: video.durationSec,
      signal
    })
    updateVideo(this.ctx, projectId, video.id, (_draft, v) => {
      v.spritePath = spritePath
      v.spriteInfo = spriteInfo
    })
  }
}

function jobKey(projectId: string, videoId: string): string {
  return `${projectId}/${videoId}`
}
