// Analysis runs: one per project. ANALYSIS_PARALLEL caps the videos analysed in parallel over all
// projects (the Gemini limits belong to the API key); free slots go to the run with the fewest.
// Each video: wait for its proxy → Analyzer (upload / processing / analyzing) → replace AI moments.
// At the end the reel is selected automatically – unless the user edited it by hand (reelEdited):
// then it stays and the new moments wait as suggestions.

import { TOAST_KEYS, type StartAnalysisOptions } from '@shared/ipc'
import { ANALYSIS_PARALLEL, LIMITS } from '@shared/presets'
import { appendWish, wishProblem } from '@shared/second-pass'
import type {
  AnalysisRemedy,
  AnalysisStage,
  BriefSettings,
  Moment,
  Project,
  RemoteFileRef,
  ToastEvent,
  VideoStatus
} from '@shared/types'
import { clamp, round2 } from '@shared/util'
import type { AnalyzedMoment, AnalyzeResponse, AnalyzeStage, EarlierClip } from '../../contracts'
import { briefHash } from '../briefHash'
import { fail, isAnalyzerError, isCancellation, userMessage } from '../errors'
import { insertChronologically } from '../project/order'
import { isFiniteNumber } from '../project/sanitize'
import { applyAutoSelect } from '../selection'
import {
  abortable,
  findVideo,
  isLive,
  requireLiveProject,
  updateVideo,
  type JobContext
} from './context'
import { JOB_MESSAGES, STAGE_MESSAGES } from './messages'
import { PreviewMissingError, type PrepareQueue } from './prepare'
import { deleteRemoteFile, sameRemoteFile, trackRemoteCleanup } from './remoteFiles'

interface VideoTask {
  controller: AbortController
  /** set before the final state is written, so late stage callbacks cannot overwrite it */
  finished: boolean
}

export interface Failure {
  message: string
  remedy: AnalysisRemedy
}

interface AnalysisRun {
  projectId: string
  controller: AbortController
  queue: string[]
  active: Map<string, VideoTask>
  apiKey: string
  model: string
  hash: string
  brief: BriefSettings
  /** second pass ("Ask Gemini again"): each video's clips from before the run, for Gemini */
  earlier?: Map<string, EarlierClip[]>
  /** second pass: the reel was edited by hand before it – protected again if nothing is replaced */
  reelWasEdited?: boolean
  /** when this run last got a slot (sequence number, 0 = never) – ties go to the longest waiting */
  lastServed: number
  /**
   * The latest outcome of each video in this run – per video, not per attempt: a video queued
   * again ("Try again" while the run goes on) starts over, and a removed one leaves.
   * results: moments found per analysed video.
   */
  results: Map<string, number>
  failures: Map<string, Failure>
  /**
   * what happened to the reel, decided in the same update as the run's last result (so the
   * renderer never sees a finished run without its reel); unset: finish() decides
   */
  reel?: 'kept' | 'selected'
  finished: boolean
}

/** errors that will hit every remaining video of the run in the same way */
const FATAL_ANALYZER_CODES = new Set(['auth', 'model'])

/**
 * Also fatal: a quota error that will not clear by waiting (daily quota, paid-only model on the
 * free tier, empty prepaid balance). Per-minute quota errors stay retryable and only fail one video.
 */
export function isFatalForRun(err: unknown): boolean {
  if (!isAnalyzerError(err)) return false
  return FATAL_ANALYZER_CODES.has(err.code) || (err.code === 'quota' && !err.retryable)
}
const STAGE_UPDATE_INTERVAL_MS = 250
const MAX_TITLE_LENGTH = 60

/** a failure reason that already tells the user to try again */
const OFFERS_RETRY = /again/i

const byLoadThenWaiting = (a: AnalysisRun, b: AnalysisRun): number =>
  a.active.size - b.active.size || a.lastServed - b.lastServed

/**
 * What can help after a failed analysis (stored as status.analysis.remedy): key, model, quota or
 * billing need the settings; a missing preview needs the Videos step; a safety block stays;
 * everything else may work on the next try.
 */
export function analysisRemedy(err: unknown): AnalysisRemedy {
  if (err instanceof PreviewMissingError) return 'prepare'
  if (!isAnalyzerError(err)) return 'retry'
  switch (err.code) {
    case 'auth':
    case 'model':
      return 'settings'
    case 'quota':
      return err.retryable ? 'retry' : 'settings'
    case 'safety':
      return 'none'
    default:
      return 'retry'
  }
}

/** the run-level toast about failed videos: their shared reason, else a pointer to the videos */
export function failureToast(failures: readonly Failure[], succeeded: number): ToastEvent {
  const level = succeeded > 0 ? 'warning' : 'error'
  const retry = failures.every((failure) => failure.remedy === 'retry')
  const reason = failures[0].message
  if (failures.every((failure) => failure.message === reason)) {
    const hint = retry && !OFFERS_RETRY.test(reason) ? ` ${JOB_MESSAGES.retryHint}` : ''
    const message =
      succeeded > 0
        ? JOB_MESSAGES.analysisPartlyFailed(failures.length, reason)
        : JOB_MESSAGES.analysisAllFailed(reason)
    return { level, message: message + hint }
  }
  const hint = retry ? ` ${JOB_MESSAGES.retryHint}` : ''
  return { level, message: JOB_MESSAGES.analysisFailedMixed(failures.length) + hint }
}

/**
 * A video is fresh when its result belongs to the current brief + model and no later attempt
 * failed, was cancelled or was interrupted (StartAnalysisOptions: those count as targets).
 */
export function isAnalysisFresh(project: Project, videoId: string, hash: string): boolean {
  const stage = project.status[videoId]?.analysis.stage
  return project.analyses[videoId]?.briefHash === hash && stage !== 'error' && stage !== 'cancelled'
}

/** every clip of the project by video, with the times Gemini chose (not the user's trims) */
function earlierClips(project: Project): Map<string, EarlierClip[]> {
  const byVideo = new Map<string, EarlierClip[]>()
  for (const moment of project.moments) {
    const clips = byVideo.get(moment.videoId) ?? []
    clips.push({
      start: moment.aiStart ?? moment.start,
      end: moment.aiEnd ?? moment.end,
      title: moment.title,
      score: moment.score,
      inReel: moment.selected
    })
    byVideo.set(moment.videoId, clips)
  }
  return byVideo
}

function toMoment(
  raw: AnalyzedMoment,
  videoId: string,
  durationSec: number,
  id: string
): Moment | null {
  if (!isFiniteNumber(raw.start) || !isFiniteNumber(raw.end)) return null
  const last = Math.floor(durationSec * 100) / 100
  const start = clamp(round2(raw.start), 0, last)
  const end = clamp(round2(raw.end), 0, last)
  if (end - start < LIMITS.minMomentSec) return null
  return {
    id,
    videoId,
    start,
    end,
    title:
      (typeof raw.title === 'string' ? raw.title.trim() : '').slice(0, MAX_TITLE_LENGTH) ||
      'Moment',
    reason: typeof raw.reason === 'string' ? raw.reason.trim() : '',
    score: isFiniteNumber(raw.score) ? clamp(Math.round(raw.score), 1, 10) : 5,
    selected: false,
    aiStart: start,
    aiEnd: end
  }
}

export class AnalysisRunner {
  private readonly ctx: JobContext
  private readonly prepare: PrepareQueue
  /** in start order */
  private readonly runs = new Map<string, AnalysisRun>()
  private servedCount = 0
  /**
   * Second passes that did not get through (failed or cancelled videos; in memory only): the
   * earlier clips of the videos still to analyse, for the next run of the same brief ("Try
   * again", "Retry failed videos").
   */
  private readonly unfinished = new Map<
    string,
    { hash: string; earlier: Map<string, EarlierClip[]> }
  >()

  constructor(ctx: JobContext, prepare: PrepareQueue) {
    this.ctx = ctx
    this.prepare = prepare
  }

  isRunning(projectId: string): boolean {
    return this.runs.has(projectId)
  }

  /**
   * Resolves once the videos are queued – and the renderer has the queued state; progress is
   * published through the project. Nothing to analyse (every video fresh) is a no-op: the
   * renderer's own freshness check may lag behind.
   *
   * With `wish` ("Ask Gemini again") it is one step: the wish becomes the last line of the brief,
   * the reel counts as automatic again (the run puts it together anew), and Gemini gets each
   * video's clips from before the run. Not while a run is going. Videos the second pass does not
   * get through keep their list for the next run of the same brief (`unfinished`).
   */
  async start(projectId: string, options: StartAnalysisOptions = {}, wish?: string): Promise<void> {
    const apiKey = await this.ctx.settings.getApiKey()
    // read after the key: that a stored key cannot be decrypted is only known now
    const settings = this.ctx.settings.getAppSettings()
    if (!apiKey && !settings.fakeAi) {
      fail(
        'no-api-key',
        settings.apiKeyUnreadable ? JOB_MESSAGES.apiKeyUnreadable : JOB_MESSAGES.noApiKey
      )
    }
    // after the await: the project may be on its way out by now
    let project = requireLiveProject(this.ctx, projectId)
    if (project.videos.length === 0) fail('invalid', JOB_MESSAGES.noVideos)
    let earlier: AnalysisRun['earlier']
    const reelWasEdited = wish !== undefined && project.reelEdited
    if (wish !== undefined) {
      if (this.runs.has(projectId)) fail('busy', JOB_MESSAGES.analysisBusy)
      if (wishProblem(project.brief.prompt, wish)) fail('invalid', JOB_MESSAGES.wishTooLong)
      // read before the run replaces anything
      earlier = earlierClips(project)
      project = this.ctx.store.update(projectId, (draft) => {
        draft.brief.prompt = appendWish(draft.brief.prompt, wish)
        draft.reelEdited = false
      })
    }
    const hash = briefHash(project.brief, settings.model)
    if (wish === undefined) {
      // a second pass that failed or was cancelled goes on while the brief stays the same
      const open = this.unfinished.get(projectId)
      if (open?.hash === hash) earlier = open.earlier
      else this.unfinished.delete(projectId)
    }
    const targets = this.targets(project, hash, options)

    const existing = this.runs.get(projectId)
    if (existing) {
      this.extend(existing, targets, options, hash)
    } else {
      if (targets.length === 0) return
      const run: AnalysisRun = {
        projectId,
        controller: new AbortController(),
        queue: [],
        active: new Map(),
        apiKey: apiKey ?? '',
        model: settings.model,
        hash,
        brief: structuredClone(project.brief),
        earlier,
        reelWasEdited,
        lastServed: 0,
        results: new Map(),
        failures: new Map(),
        finished: false
      }
      this.runs.set(projectId, run)
      this.ctx.log.info('analysis', 'run started', {
        projectId,
        videos: targets.length,
        model: run.model
      })
      this.enqueue(run, targets)
    }
    this.pump()
    // the renderer switches to the analysis step when this resolves: it must see the queue
    this.ctx.notify.flushProject(projectId)
  }

  private targets(project: Project, hash: string, options: StartAnalysisOptions): string[] {
    if (options.videoIds !== undefined) {
      const wanted = new Set(options.videoIds)
      for (const id of wanted) {
        if (!findVideo(project, id)) fail('not-found', JOB_MESSAGES.videoNotFound)
      }
      return project.videos.filter((video) => wanted.has(video.id)).map((video) => video.id)
    }
    return project.videos
      .filter((video) => options.force === true || !isAnalysisFresh(project, video.id, hash))
      .map((video) => video.id)
  }

  /** explicit videos (e.g. "Try again") join a running run with the same brief */
  private extend(
    run: AnalysisRun,
    targets: string[],
    options: StartAnalysisOptions,
    hash: string
  ): void {
    const additions = targets.filter((id) => !run.queue.includes(id) && !run.active.has(id))
    if (
      options.videoIds === undefined ||
      run.hash !== hash ||
      run.controller.signal.aborted ||
      additions.length === 0
    ) {
      fail('busy', JOB_MESSAGES.analysisBusy)
    }
    // the run goes on: its reel is settled again at its (new) end
    run.reel = undefined
    this.enqueue(run, additions)
  }

  /**
   * Queues the videos. One without a preview whose preparation failed fails right away – Gemini
   * cannot help with that, the Videos step can.
   */
  private enqueue(run: AnalysisRun, videoIds: string[]): void {
    const project = this.ctx.store.find(run.projectId)
    const queue: string[] = []
    const noPreview: string[] = []
    for (const videoId of videoIds) {
      // a video queued again starts over: its earlier outcome in this run no longer counts
      run.results.delete(videoId)
      run.failures.delete(videoId)
      const video = findVideo(project, videoId)
      const failed =
        !!video &&
        !video.proxyPath &&
        project?.status[videoId]?.prepare.status === 'error' &&
        !this.prepare.isQueued(run.projectId, videoId)
      if (failed) noPreview.push(videoId)
      else queue.push(videoId)
    }
    run.queue.push(...queue)
    this.markQueued(run.projectId, queue)
    const finishedAt = this.ctx.now().toISOString()
    for (const videoId of noPreview) {
      const err = new PreviewMissingError(project?.status[videoId]?.prepare.error)
      this.ctx.log.warn('analysis', 'video without preview not analysed', {
        projectId: run.projectId,
        videoId
      })
      this.markFailed(run, videoId, err, { finishedAt })
    }
  }

  cancel(projectId: string): void {
    const run = this.runs.get(projectId)
    if (!run) return
    run.controller.abort()
    for (const task of run.active.values()) task.controller.abort()
    const queued = run.queue.splice(0)
    for (const videoId of queued) {
      this.setAnalysis(projectId, videoId, {
        stage: 'cancelled',
        progress: 0,
        message: JOB_MESSAGES.cancelled
      })
    }
    this.ctx.log.info('analysis', 'run cancelled', { projectId })
    this.pump()
  }

  /** the video is being removed: it leaves the run, and the run's summary forgets it */
  cancelVideo(projectId: string, videoId: string): void {
    const run = this.runs.get(projectId)
    if (!run) return
    run.queue = run.queue.filter((id) => id !== videoId)
    run.results.delete(videoId)
    run.failures.delete(videoId)
    run.active.get(videoId)?.controller.abort()
    this.pump()
  }

  cancelAll(): void {
    for (const projectId of [...this.runs.keys()]) this.cancel(projectId)
  }

  private markQueued(projectId: string, videoIds: string[]): void {
    if (videoIds.length === 0) return
    this.ctx.store.update(projectId, (draft) => {
      for (const videoId of videoIds) {
        if (!draft.status[videoId]) continue
        draft.status[videoId].analysis = {
          stage: 'queued',
          progress: 0,
          message: STAGE_MESSAGES.queued
        }
      }
    })
  }

  private setAnalysis(
    projectId: string,
    videoId: string,
    analysis: VideoStatus['analysis'],
    persist = true
  ): void {
    updateVideo(
      this.ctx,
      projectId,
      videoId,
      (draft) => {
        draft.status[videoId] = { ...draft.status[videoId], analysis }
      },
      { persist }
    )
  }

  /**
   * The video's error state with what can help; the run remembers it for its summary. `last`: the
   * run ends with this video – its reel is settled in the same update.
   */
  private markFailed(
    run: AnalysisRun,
    videoId: string,
    err: unknown,
    times: { startedAt?: string; finishedAt: string },
    last = false
  ): void {
    const message = userMessage(err, JOB_MESSAGES.analysisFailed)
    const remedy = analysisRemedy(err)
    run.results.delete(videoId)
    const updated = updateVideo(this.ctx, run.projectId, videoId, (draft) => {
      const analysis = { stage: 'error' as const, progress: 0, error: message, remedy, ...times }
      draft.status[videoId] = { ...draft.status[videoId], analysis }
      if (last) this.settleReel(run, draft, run.results.size)
    })
    // a video that is gone meanwhile is not reported at the end of the run
    if (updated) run.failures.set(videoId, { message, remedy })
  }

  /** nothing but `videoId` keeps the run going: its final state ends the run */
  private endsRun(run: AnalysisRun, videoId: string): boolean {
    return run.queue.length === 0 && [...run.active.keys()].every((id) => id === videoId)
  }

  /**
   * The reel at the end of a run (≥ 1 success, also a cancelled one), decided at that moment, so
   * edits made during the run count: a reel edited by hand stays – unless the run would leave it
   * without a single clip; otherwise it is selected automatically.
   */
  private settleReel(run: AnalysisRun, draft: Project, succeeded: number): void {
    if (succeeded === 0) return
    const keep = draft.reelEdited && draft.moments.some((moment) => moment.selected)
    if (!keep) applyAutoSelect(draft)
    run.reel = keep ? 'kept' : 'selected'
  }

  /** fills the free slots, then completes drained runs */
  private pump(): void {
    let running = 0
    for (const run of this.runs.values()) running += run.active.size
    for (let run = this.nextRun(); run && running < ANALYSIS_PARALLEL; run = this.nextRun()) {
      this.startVideo(run)
      running++
    }
    for (const run of [...this.runs.values()]) {
      const drained = run.queue.length === 0 || run.controller.signal.aborted
      if (run.active.size === 0 && drained && !run.finished) {
        run.finished = true
        this.runs.delete(run.projectId)
        this.finish(run)
      }
    }
  }

  /** the waiting run with the fewest running videos; ties go to the one served longest ago */
  private nextRun(): AnalysisRun | undefined {
    let best: AnalysisRun | undefined
    for (const run of this.runs.values()) {
      if (run.controller.signal.aborted || run.queue.length === 0) continue
      if (!best || byLoadThenWaiting(run, best) < 0) best = run
    }
    return best
  }

  private startVideo(run: AnalysisRun): void {
    const videoId = this.takeNext(run)
    const task: VideoTask = { controller: new AbortController(), finished: false }
    run.active.set(videoId, task)
    run.lastServed = ++this.servedCount
    const job = this.analyse(run, videoId, task).finally(() => {
      run.active.delete(videoId)
      this.pump()
    })
    this.ctx.tasks.track(run.projectId, job)
  }

  /** prefers a video whose proxy is ready, so workers do not idle while proxies are rendered */
  private takeNext(run: AnalysisRun): string {
    const project = this.ctx.store.find(run.projectId)
    const ready = run.queue.findIndex((id) => !!findVideo(project, id)?.proxyPath)
    return run.queue.splice(ready >= 0 ? ready : 0, 1)[0]
  }

  private stageReporter(run: AnalysisRun, videoId: string, task: VideoTask, startedAt: string) {
    let lastStage: AnalysisStage | null = null
    let lastAt = 0
    return (stage: AnalyzeStage | 'waiting-proxy', progress: number): void => {
      if (task.finished || task.controller.signal.aborted) return
      const now = Date.now()
      const value = Number.isFinite(progress) && progress >= 0 ? Math.min(1, progress) : -1
      if (stage === lastStage && value < 1 && now - lastAt < STAGE_UPDATE_INTERVAL_MS) return
      const changed = stage !== lastStage
      lastStage = stage
      lastAt = now
      // stage changes are persisted, progress ticks only broadcast
      this.setAnalysis(
        run.projectId,
        videoId,
        { stage, progress: value, message: STAGE_MESSAGES[stage], startedAt },
        changed
      )
    }
  }

  private async analyse(run: AnalysisRun, videoId: string, task: VideoTask): Promise<void> {
    const { projectId } = run
    const signal = task.controller.signal
    const startedAt = this.ctx.now().toISOString()
    const report = this.stageReporter(run, videoId, task, startedAt)
    try {
      let video = findVideo(this.ctx.store.find(projectId), videoId)
      if (!video) return
      if (!video.proxyPath) report('waiting-proxy', -1)
      const proxy = await this.prepare.waitForProxy(projectId, videoId, signal)
      // a few seconds of ffmpeg on the first analysis, shown as the start of the upload
      // (0, not -1: the renderer counts -1 as 35 % of the stage, the upload then starts lower)
      const proxyPath = await this.prepare.ensureAnalysisCopy(projectId, video, proxy, signal, () =>
        report('uploading', 0)
      )
      const proxyFingerprint = await this.ctx.media.fingerprint(proxyPath)
      const project = this.ctx.store.find(projectId)
      video = findVideo(project, videoId)
      if (!project || !video) return
      // abortable: a cancel takes effect even if the analyzer is slow to honour the signal
      const response = await abortable(
        this.ctx.analyzer.analyze({
          apiKey: run.apiKey,
          model: run.model,
          video: {
            proxyPath,
            proxyFingerprint,
            durationSec: video.durationSec,
            fileName: video.fileName,
            recordedAt: video.recordedAt
          },
          brief: run.brief,
          earlierClips: run.earlier?.get(videoId),
          // persisted: also an upload of an attempt before an app restart is reused
          remoteFile: project.remoteFiles[videoId] ?? null,
          onRemoteFile: (file) => this.remoteFileReported(run, videoId, task, file),
          // e.g. deleting an upload Gemini was still processing when the user cancelled or quit
          onCleanup: (cleanup) => trackRemoteCleanup(this.ctx, cleanup),
          onStage: report,
          signal
        }),
        signal
      )
      task.finished = true
      this.ctx.settings.reportKeyCheck?.(run.apiKey, true)
      this.applyResult(run, videoId, response, startedAt)
    } catch (err) {
      task.finished = true
      // Settings shows that Google rejected the key (instead of "Connected")
      if (isAnalyzerError(err) && err.code === 'auth') {
        this.ctx.settings.reportKeyCheck?.(run.apiKey, false)
      }
      const finishedAt = this.ctx.now().toISOString()
      if (isCancellation(err, signal)) {
        this.setAnalysis(projectId, videoId, {
          stage: 'cancelled',
          progress: 0,
          message: JOB_MESSAGES.cancelled,
          startedAt,
          finishedAt
        })
        return
      }
      this.ctx.log.warn('analysis', 'video failed', { projectId, videoId, err })
      // first the queue: afterwards this video may be the one that ends the run
      if (isFatalForRun(err)) this.failQueued(run, err)
      this.markFailed(run, videoId, err, { startedAt, finishedAt }, this.endsRun(run, videoId))
    }
  }

  /** the API key, model or quota is unusable – the other queued videos would fail the same way */
  private failQueued(run: AnalysisRun, err: unknown): void {
    const queued = run.queue.splice(0)
    const finishedAt = this.ctx.now().toISOString()
    for (const videoId of queued) this.markFailed(run, videoId, err, { finishedAt })
  }

  /**
   * The analyzer's upload is active (onRemoteFile): record it right away, so a failed or cancelled
   * analysis can still reuse it and removing the video or project deletes it.
   */
  private remoteFileReported(
    run: AnalysisRun,
    videoId: string,
    task: VideoTask,
    file: RemoteFileRef
  ): void {
    const { projectId } = run
    const project = this.ctx.store.find(projectId)
    if (!isLive(this.ctx, projectId) || !findVideo(project, videoId)) {
      // the video or its project left meanwhile: nobody would ever use or delete this upload
      deleteRemoteFile(this.ctx, projectId, file, run.apiKey)
      return
    }
    const current = project?.remoteFiles[videoId]
    if (task.finished && current && current.name !== file.name) {
      // a late report of an attempt that already ended: it never displaces a newer upload
      deleteRemoteFile(this.ctx, projectId, file, run.apiKey)
      return
    }
    this.setRemoteFile(projectId, videoId, file)
  }

  /** stores the video's upload; one that is replaced by another file is deleted */
  private setRemoteFile(projectId: string, videoId: string, next: RemoteFileRef): void {
    const current = this.ctx.store.find(projectId)?.remoteFiles[videoId]
    if (current && sameRemoteFile(current, next)) return
    updateVideo(this.ctx, projectId, videoId, (draft) => {
      draft.remoteFiles[videoId] = next
    })
    if (current && current.name !== next.name) deleteRemoteFile(this.ctx, projectId, current)
  }

  private applyResult(
    run: AnalysisRun,
    videoId: string,
    response: AnalyzeResponse,
    startedAt: string
  ): void {
    const finishedAt = this.ctx.now().toISOString()
    const last = this.endsRun(run, videoId)
    let count = 0
    const replaced: { file?: RemoteFileRef } = {}
    const updated = updateVideo(this.ctx, run.projectId, videoId, (draft, video) => {
      const moments = response.moments
        .map((raw) => toMoment(raw, videoId, video.durationSec, this.ctx.newId()))
        .filter((m): m is Moment => m !== null)
      count = moments.length
      // new moments start unselected next to their chronological neighbours; the order stays
      draft.moments = insertChronologically(
        draft.moments.filter((m) => m.videoId !== videoId),
        moments,
        draft.videos
      )
      draft.analyses[videoId] = {
        videoId,
        model: response.model || run.model,
        briefHash: run.hash,
        createdAt: finishedAt
      }
      replaced.file = draft.remoteFiles[videoId]
      draft.remoteFiles[videoId] = response.remoteFile
      draft.status[videoId].analysis = {
        stage: 'done',
        progress: 1,
        message: JOB_MESSAGES.momentsFound(count),
        startedAt,
        finishedAt
      }
      if (last) this.settleReel(run, draft, run.results.size + 1)
    })
    if (!updated) {
      // the video left meanwhile: its upload has no owner any more
      deleteRemoteFile(this.ctx, run.projectId, response.remoteFile, run.apiKey)
      return
    }
    const previous = replaced.file
    if (previous && previous.name !== response.remoteFile.name) {
      deleteRemoteFile(this.ctx, run.projectId, previous)
    }
    run.failures.delete(videoId)
    run.results.set(videoId, count)
    this.ctx.log.info('analysis', 'video analysed', {
      projectId: run.projectId,
      videoId,
      moments: count,
      usage: response.usage
    })
  }

  private finish(run: AnalysisRun): void {
    const { projectId } = run
    const cancelled = run.controller.signal.aborted
    const succeeded = run.results.size
    let moments = 0
    for (const count of run.results.values()) moments += count
    let project = this.ctx.store.find(projectId)
    // usually settled with the last result already; not when the run ended otherwise (cancelled)
    if (!run.reel && project && succeeded > 0) {
      project = this.ctx.store.update(projectId, (draft) => {
        this.settleReel(run, draft, succeeded)
      })
    }
    if (run.earlier) {
      // videos the second pass did not get through keep their list for the next run of this brief
      for (const videoId of run.results.keys()) run.earlier.delete(videoId)
      if (project && run.earlier.size > 0) {
        this.unfinished.set(projectId, { hash: run.hash, earlier: run.earlier })
      } else {
        this.unfinished.delete(projectId)
      }
    }
    if (run.reelWasEdited && succeeded === 0 && project && !project.reelEdited) {
      // nothing was replaced: the reel edited by hand is protected again
      this.ctx.store.update(projectId, (draft) => {
        draft.reelEdited = true
      })
    }
    const keepReel = run.reel === 'kept'
    // the renderer gets the final state before the toasts that announce it
    this.ctx.notify.flushProject(projectId)
    if (succeeded > 0 && project && !cancelled) {
      const message = keepReel
        ? JOB_MESSAGES.analysisDoneReelKept(moments)
        : JOB_MESSAGES.analysisDone(moments, succeeded)
      this.ctx.notify.toast({ level: 'success', message, projectId })
    }
    if (!cancelled && run.failures.size > 0 && this.ctx.store.find(projectId)) {
      // stays until closed: nobody watches a festival's analysis the whole time
      const toast = failureToast([...run.failures.values()], succeeded)
      // replaces the failure toast of an earlier run; closed when the next run starts
      const key = TOAST_KEYS.analysisFailed(projectId)
      this.ctx.notify.toast({ ...toast, projectId, sticky: true, key })
    }
    this.ctx.log.info('analysis', 'run finished', {
      projectId,
      succeeded,
      failed: run.failures.size,
      moments,
      cancelled,
      reelKept: keepReel
    })
  }
}
