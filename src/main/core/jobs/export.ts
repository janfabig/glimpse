// Export: selected moments (in output order) → RenderJob on the original files → highlight video.

import { estimateExportBytes, outputSize } from '@shared/export-size'
import { TOAST_KEYS } from '@shared/ipc'
import { EXPORT_FIXED, LIMITS } from '@shared/presets'
import type { ExportProgress, ExportRecord, Project, ToastEvent } from '@shared/types'
import { clamp } from '@shared/util'
import { mkdir, rmdir, stat } from 'node:fs/promises'
import type { RenderClip, RenderJob, RenderProgress } from '../../contracts'
import {
  DISK_FULL_MESSAGE,
  fail,
  folderFullMessage,
  isCancellation,
  isDiskFull,
  userMessage
} from '../errors'
import { removePath, removeStalePartFiles } from '../fsx'
import { PROJECT_NOT_FOUND } from '../project/store'
import { effectiveLength, transitionOverlap } from '../selection'
import { isLive, requireLiveProject, throwIfAborted, type JobContext } from './context'
import { ensureFreeSpace, exportWorkBytes, outputFullMessage } from './diskSpace'
import { exportMemoryBytes, memoryBudget } from './exportMemory'
import { JOB_MESSAGES } from './messages'
import { exportBaseName, outputKey, uniqueOutputPath } from './outputName'

const MAX_HISTORY = 50

type ProgressUpdate = Omit<ExportProgress, 'projectId' | 'exportId'>

interface ExportRun {
  projectId: string
  exportId: string
  controller: AbortController
  clipCount: number
  /** what its ffmpeg needs at the peak (exportMemory.ts); 0 until the job is built */
  memoryBytes: number
  /** progress never moves backwards */
  progress: number
}

/** RenderProgress → ExportProgress fields; overall progress stays below 1 until the file is saved */
export function mapRenderProgress(p: RenderProgress, previous: number): ProgressUpdate {
  const progress = Math.max(previous, clamp(Number.isFinite(p.fraction) ? p.fraction : 0, 0, 0.99))
  const clipCount = p.clipCount
  switch (p.phase) {
    case 'rendering': {
      const currentClip = clamp((p.clipIndex ?? 0) + 1, 1, Math.max(1, clipCount))
      return {
        phase: 'rendering',
        progress,
        currentClip,
        clipCount,
        message: JOB_MESSAGES.exportRendering(currentClip, clipCount)
      }
    }
    case 'joining':
      return { phase: 'joining', progress, clipCount, message: JOB_MESSAGES.exportJoining }
    case 'finishing':
      return { phase: 'finishing', progress, clipCount, message: JOB_MESSAGES.exportFinishing }
  }
}

export class ExportRunner {
  private readonly ctx: JobContext
  private readonly runs = new Map<string, ExportRun>()
  /** outputKey() of every file a running export will write */
  private readonly reservedOutputs = new Set<string>()

  constructor(ctx: JobContext) {
    this.ctx = ctx
  }

  isRunning(projectId: string): boolean {
    return this.runs.has(projectId)
  }

  /** validates and starts the export; resolves with its id while rendering continues */
  async start(projectId: string): Promise<{ exportId: string }> {
    if (this.runs.has(projectId)) fail('busy', JOB_MESSAGES.exportBusy)
    const run: ExportRun = {
      projectId,
      exportId: this.ctx.newId(),
      controller: new AbortController(),
      clipCount: 0,
      memoryBytes: 0,
      progress: 0
    }
    // claim the slot before the first await, so a double click cannot start two exports
    this.runs.set(projectId, run)
    let job: RenderJob
    try {
      // tracked like the render: deleting the project waits for it instead of racing its mkdir
      job = await this.ctx.tasks.track(projectId, this.buildJob(run))
    } catch (err) {
      this.runs.delete(projectId)
      throw err
    }
    run.clipCount = job.clips.length
    this.ctx.log.info('export', 'started', {
      projectId,
      exportId: run.exportId,
      clips: run.clipCount,
      output: job.outputPath
    })
    this.emit(run, {
      phase: 'preparing',
      progress: 0,
      clipCount: run.clipCount,
      message: JOB_MESSAGES.exportPreparing
    })
    this.ctx.tasks.track(projectId, this.render(run, job))
    return { exportId: run.exportId }
  }

  cancel(projectId: string): void {
    this.runs.get(projectId)?.controller.abort()
  }

  cancelAll(): void {
    for (const run of this.runs.values()) run.controller.abort()
  }

  private async buildJob(run: ExportRun): Promise<RenderJob> {
    const project = requireLiveProject(this.ctx, run.projectId)
    const selected = project.moments.filter((m) => m.selected)
    if (selected.length === 0) fail('nothing-selected', JOB_MESSAGES.nothingSelected)

    const ffmpeg = await this.ctx.media.status()
    if (!ffmpeg.ok) fail('no-ffmpeg', ffmpeg.error ?? JOB_MESSAGES.noFfmpeg)

    const clips: RenderClip[] = []
    for (const moment of selected) {
      const video = project.videos.find((v) => v.id === moment.videoId)
      if (!video) fail('not-found', JOB_MESSAGES.clipWithoutVideo)
      const start = clamp(moment.start, 0, video.durationSec)
      const end = clamp(moment.end, 0, video.durationSec)
      if (end - start < LIMITS.minMomentSec - 1e-9)
        fail('invalid', JOB_MESSAGES.clipTooShort(moment.title))
      clips.push({
        sourcePath: video.path,
        start,
        end,
        hasAudio: video.hasAudio,
        sourceWidth: video.width,
        sourceHeight: video.height
      })
    }
    this.claimMemory(run, project, clips)
    const sources = new Map(clips.map((clip) => [clip.sourcePath, clip]))
    for (const path of sources.keys()) {
      const video = project.videos.find((v) => v.path === path)
      const fileName = video?.fileName ?? path
      const size = await stat(path).then(
        (info) => (info.isFile() ? info.size : -1),
        () => -1
      )
      if (size < 0) fail('not-found', JOB_MESSAGES.missingOriginal(fileName))
      // another recording at the same path (Finder "Replace") would be cut at this one's timestamps
      if (video && video.sizeBytes > 0 && size !== video.sizeBytes)
        fail('invalid', JOB_MESSAGES.changedOriginal(fileName))
    }

    const outputDir =
      project.exportSettings.outputDir ?? this.ctx.settings.getAppSettings().defaultOutputDir
    try {
      await mkdir(outputDir, { recursive: true })
    } catch (err) {
      this.ctx.log.warn('export', 'output folder not usable', { outputDir, err })
      fail(
        'invalid',
        isDiskFull(err)
          ? await outputFullMessage(this.ctx.disk, outputDir, this.ctx.paths.projectDir(project.id))
          : JOB_MESSAGES.outputDirFailed(outputDir)
      )
    }
    // the join of an export that died with the app or the Mac: gigabytes, hidden in Finder
    const stale = await removeStalePartFiles(outputDir)
    if (stale > 0)
      this.ctx.log.info('export', 'removed unfinished files of earlier exports', { stale })
    await this.ensureSpace(project, clips, outputDir)
    const outputPath = await uniqueOutputPath(
      outputDir,
      exportBaseName(project.name, this.ctx.now()),
      this.reservedOutputs
    )
    // the work dir lives in the project folder: never recreate it while or after it is deleted
    if (!isLive(this.ctx, run.projectId)) fail('not-found', PROJECT_NOT_FOUND)
    const reservation = outputKey(outputPath)
    this.reservedOutputs.add(reservation)
    const workDir = this.ctx.paths.exportWorkDir(run.projectId, run.exportId)
    try {
      await mkdir(workDir, { recursive: true })
    } catch (err) {
      this.reservedOutputs.delete(reservation)
      this.ctx.log.warn('export', 'work dir not created', { workDir, err })
      fail('internal', isDiskFull(err) ? DISK_FULL_MESSAGE : JOB_MESSAGES.exportPrepareFailed)
    }
    return {
      clips,
      settings: structuredClone(project.exportSettings),
      frame: { shortSide: EXPORT_FIXED.shortSide, fps: EXPORT_FIXED.fps },
      outputPath,
      workDir
    }
  }

  /**
   * ffmpeg must never exhaust the Mac's memory (a 4K encode takes gigabytes, whatever the number
   * of clips): an export next to running ones starts only when all of them fit. Checked before
   * anything is rendered; an export alone runs unless its frame alone is too big.
   */
  private claimMemory(run: ExportRun, project: Project, clips: RenderClip[]): void {
    const { aspect, transition } = project.exportSettings
    const frame = outputSize(aspect, { width: clips[0].sourceWidth, height: clips[0].sourceHeight })
    const memory = exportMemoryBytes(frame, transition === 'crossfade' && clips.length > 1)
    let running = 0
    for (const other of this.runs.values()) running += other.memoryBytes
    const budget = memoryBudget(this.ctx.memoryBytes)
    // "Original" of a very wide or tall video makes a frame far bigger than 9:16: it never runs
    if (memory > budget) fail('invalid', JOB_MESSAGES.exportFrameTooBig)
    // next to others an export counts as a 9:16 frame at least: ffmpeg's footprint has a fixed
    // part, so the plan by pixels is too tight for several small frames
    const full = outputSize('9:16', null)
    const claim = memory * Math.max(1, (full.width * full.height) / (frame.width * frame.height))
    if (running > 0 && running + claim > budget) fail('busy', JOB_MESSAGES.exportMemoryBusy)
    run.memoryBytes = claim
  }

  /**
   * The rendered clips (in the project folder) and the final video (in the output folder) have to
   * fit – checked before ffmpeg starts, so a full disk is reported right away.
   */
  private async ensureSpace(
    project: Project,
    clips: RenderClip[],
    outputDir: string
  ): Promise<void> {
    const crossfade = project.exportSettings.transition === 'crossfade' && clips.length > 1
    const first = clips[0]
    const lengthSec = effectiveLength(clips, transitionOverlap(project))
    const estimate = estimateExportBytes(
      project.exportSettings.aspect,
      first ? { width: first.sourceWidth, height: first.sourceHeight } : null,
      lengthSec
    )
    const longestSec = Math.max(...clips.map((clip) => clip.end - clip.start))
    const workBytes = exportWorkBytes(
      estimate,
      crossfade ? Math.min(1, longestSec / lengthSec) : null
    )
    await ensureFreeSpace(this.ctx, [
      // an export folder on another drive is named: freeing space on the Mac would not help
      { path: outputDir, bytes: estimate, fullMessage: folderFullMessage(outputDir) },
      { path: this.ctx.paths.projectDir(project.id), bytes: workBytes }
    ])
  }

  private emit(run: ExportRun, update: ProgressUpdate): void {
    run.progress = Math.max(run.progress, update.progress)
    this.ctx.notify.exportProgress({ projectId: run.projectId, exportId: run.exportId, ...update })
  }

  private async render(run: ExportRun, job: RenderJob): Promise<void> {
    const { signal } = run.controller
    let terminal: ProgressUpdate
    let toast: ToastEvent | null = null
    try {
      // cancelled while the job was being built: no need to start ffmpeg
      throwIfAborted(signal)
      const result = await this.ctx.media.renderHighlight(job, {
        signal,
        onProgress: (p) => {
          if (!signal.aborted) this.emit(run, mapRenderProgress(p, run.progress))
        }
      })
      const record: ExportRecord = {
        id: run.exportId,
        path: result.outputPath,
        createdAt: this.ctx.now().toISOString(),
        durationSec: result.durationSec,
        clipCount: job.clips.length,
        sizeBytes: result.sizeBytes
      }
      this.ctx.store.updateIfExists(run.projectId, (draft) => {
        draft.exports = [...draft.exports, record].slice(-MAX_HISTORY)
      })
      this.ctx.log.info('export', 'finished', {
        projectId: run.projectId,
        exportId: run.exportId,
        output: result.outputPath
      })
      terminal = {
        phase: 'done',
        progress: 1,
        clipCount: run.clipCount,
        outputPath: result.outputPath,
        message: JOB_MESSAGES.exportDone
      }
      toast = { level: 'success', message: JOB_MESSAGES.exportSaved, projectId: run.projectId }
    } catch (err) {
      if (isCancellation(err, signal)) {
        this.ctx.log.info('export', 'cancelled', {
          projectId: run.projectId,
          exportId: run.exportId
        })
        terminal = {
          phase: 'cancelled',
          progress: run.progress,
          clipCount: run.clipCount,
          message: JOB_MESSAGES.exportCancelled
        }
      } else {
        const message = userMessage(err, JOB_MESSAGES.exportFailed)
        this.ctx.log.error('export', 'failed', {
          projectId: run.projectId,
          exportId: run.exportId,
          err
        })
        terminal = {
          phase: 'error',
          progress: run.progress,
          clipCount: run.clipCount,
          message,
          error: message
        }
        // stays until closed: an export of a long reel runs while the user does something else
        toast = {
          level: 'error',
          message: JOB_MESSAGES.exportFailedToast(message),
          projectId: run.projectId,
          sticky: true,
          key: TOAST_KEYS.exportFailed(run.projectId)
        }
      }
    } finally {
      await removePath(job.workDir).catch((err: unknown) =>
        this.ctx.log.warn('export', 'work dir not removed', { workDir: job.workDir, err })
      )
      await rmdir(this.ctx.paths.projectTmpDir(run.projectId)).catch(() => undefined)
      this.reservedOutputs.delete(outputKey(job.outputPath))
      this.runs.delete(run.projectId)
    }
    // the project with its new ExportRecord reaches the renderer before the terminal event
    this.ctx.notify.flushProject(run.projectId)
    this.emit(run, terminal)
    if (toast) this.ctx.notify.toast(toast)
  }
}
