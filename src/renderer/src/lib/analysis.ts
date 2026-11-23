// Derived state of the analysis run and the background preparation (proxy + filmstrip).

import type { StartAnalysisOptions } from '@shared/ipc'
import { ANALYSIS_PARALLEL } from '@shared/presets'
import type {
  AnalysisRemedy,
  AnalysisStage,
  Moment,
  Project,
  VideoInfo,
  VideoStatus
} from '@shared/types'
import { isAnalysisFresh, lastAttemptFailed } from './brief-hash'
import { isMissingOriginal } from './project'

export const RUNNING_STAGES: readonly AnalysisStage[] = [
  'queued',
  'waiting-proxy',
  'uploading',
  'processing',
  'analyzing'
]

export function isRunningStage(stage: AnalysisStage): boolean {
  return RUNNING_STAGES.includes(stage)
}

export function stageOf(project: Project, video: VideoInfo): AnalysisStage {
  return project.status[video.id]?.analysis.stage ?? 'idle'
}

export function isAnalysisRunning(project: Project): boolean {
  return project.videos.some((video) => isRunningStage(stageOf(project, video)))
}

/** share of the whole per-video pipeline that is behind a video at the given stage */
const STAGE_SPAN: Partial<Record<AnalysisStage, [number, number]>> = {
  queued: [0, 0],
  'waiting-proxy': [0, 0.05],
  uploading: [0.05, 0.35],
  processing: [0.35, 0.5],
  analyzing: [0.5, 0.97]
}

export function stageFraction(stage: AnalysisStage, progress: number): number {
  if (stage === 'done') return 1
  const span = STAGE_SPAN[stage]
  if (!span) return 0
  const within = progress < 0 ? 0.35 : Math.min(1, Math.max(0, progress))
  return span[0] + (span[1] - span[0]) * within
}

export interface AnalysisOverview {
  /** videos taking part in the current or last run (stage ≠ idle) */
  total: number
  done: number
  failed: number
  cancelled: number
  /** running = in one of the RUNNING_STAGES (queued included) */
  running: number
  active: boolean
  /** 0..1 over all videos of the run */
  fraction: number
  /** AI moments found so far */
  momentCount: number
  /** videos that delivered results */
  analysedVideos: number
}

export function analysisOverview(project: Project): AnalysisOverview {
  let total = 0
  let done = 0
  let failed = 0
  let cancelled = 0
  let running = 0
  let fractionSum = 0
  for (const video of project.videos) {
    const analysis = project.status[video.id]?.analysis
    if (!analysis || analysis.stage === 'idle') continue
    total++
    if (analysis.stage === 'done') done++
    else if (analysis.stage === 'error') failed++
    else if (analysis.stage === 'cancelled') cancelled++
    else running++
    fractionSum += stageFraction(analysis.stage, analysis.progress)
  }
  return {
    total,
    done,
    failed,
    cancelled,
    running,
    active: running > 0,
    fraction: total === 0 ? 0 : fractionSum / total,
    momentCount: project.moments.length,
    analysedVideos: Object.keys(project.analyses).length
  }
}

/** typical wall time of the analysis of a ~5-minute video [low, high] in seconds */
export const ANALYSIS_SEC_PER_VIDEO = [60, 120] as const

/**
 * Rough remaining wall time of the running analysis in seconds: measured time per finished
 * video when available, otherwise the typical time.
 */
export function estimateRemainingSec(project: Project): number | null {
  const measured: number[] = []
  let remainingUnits = 0
  let pending = 0
  for (const video of project.videos) {
    const analysis = project.status[video.id]?.analysis
    if (!analysis) continue
    if (analysis.stage === 'done' && analysis.startedAt && analysis.finishedAt) {
      const sec = (Date.parse(analysis.finishedAt) - Date.parse(analysis.startedAt)) / 1000
      if (sec > 0) measured.push(sec)
    }
    if (isRunningStage(analysis.stage)) {
      pending++
      remainingUnits += 1 - stageFraction(analysis.stage, analysis.progress)
    }
  }
  if (pending === 0) return null
  const [low, high] = ANALYSIS_SEC_PER_VIDEO
  const perVideo =
    measured.length > 0 ? measured.reduce((a, b) => a + b, 0) / measured.length : (low + high) / 2
  const parallel = Math.min(ANALYSIS_PARALLEL, pending)
  return (remainingUnits * perVideo) / parallel
}

/** "Almost done" / "About 3 min left" */
export function formatRemaining(seconds: number): string {
  if (seconds < 40) return 'Almost done'
  if (seconds < 90) return 'About 1 min left'
  return `About ${Math.round(seconds / 60)} min left`
}

export interface PrepareOverview {
  total: number
  done: number
  running: number
  pending: number
  failed: number
  /** of the failed ones: only the filmstrip is missing – the proxy is there, Gemini can analyse it */
  withoutFilmstrip: number
}

export function prepareOverview(project: Project): PrepareOverview {
  const overview: PrepareOverview = {
    total: 0,
    done: 0,
    running: 0,
    pending: 0,
    failed: 0,
    withoutFilmstrip: 0
  }
  for (const video of project.videos) {
    overview.total++
    const status = project.status[video.id]?.prepare.status ?? 'pending'
    if (status === 'done') overview.done++
    else if (status === 'running') overview.running++
    else if (status === 'error') {
      overview.failed++
      if (video.proxyPath) overview.withoutFilmstrip++
    } else overview.pending++
  }
  return overview
}

/**
 * The preview (the proxy Gemini gets) could not be made: an analysis fails right away (main:
 * remedy 'prepare'). A failed filmstrip alone does not count – the proxy is there.
 */
export function previewFailed(project: Project, videoId: string): boolean {
  const video = project.videos.find((v) => v.id === videoId)
  return project.status[videoId]?.prepare.status === 'error' && !video?.proxyPath
}

/** the proxy exists (it may have been made after the analysis failed for lack of it) */
function hasPreview(project: Project, videoId: string): boolean {
  const video = project.videos.find((v) => v.id === videoId)
  return !!video?.proxyPath || project.status[videoId]?.prepare.status === 'done'
}

/**
 * Footer text for failed previews: "1 video has no preview …". A video whose filmstrip alone
 * failed is named as such – it has its proxy, so the Prompt step counts it and Gemini analyses it.
 */
export function describePreviewFailures(failed: number, withoutFilmstrip = 0): string {
  const noPreview = failed - withoutFilmstrip
  const parts: string[] = []
  if (noPreview > 0) {
    parts.push(noPreview === 1 ? '1 video has no preview' : `${noPreview} videos have no preview`)
  }
  if (withoutFilmstrip > 0) {
    parts.push(
      withoutFilmstrip === 1
        ? '1 video has no filmstrip'
        : `${withoutFilmstrip} videos have no filmstrip`
    )
  }
  const cards = failed === 1 ? 'the marked card' : 'the marked cards'
  return `${parts.join(' and ')}. Take a look at ${cards}.`
}

// ---------------------------------------------------------------------------
// Failed analyses: what helps
// ---------------------------------------------------------------------------

/**
 * What can help with the video's last analysis: main's remedy for an error (older projects have
 * none – trying again was the only offer then), 'retry' for a cancelled one, else null.
 */
export function remedyOf(analysis: VideoStatus['analysis'] | undefined): AnalysisRemedy | null {
  if (analysis?.stage === 'cancelled') return 'retry'
  if (analysis?.stage !== 'error') return null
  return analysis.remedy ?? 'retry'
}

/**
 * What helps now: like remedyOf(), but a missing preview that exists meanwhile (the original is
 * back and the preview was made in the Videos step) only needs another try.
 */
export function currentRemedy(project: Project, videoId: string): AnalysisRemedy | null {
  const remedy = remedyOf(project.status[videoId]?.analysis)
  return remedy === 'prepare' && hasPreview(project, videoId) ? 'retry' : remedy
}

/** shown instead of main's stale "The preview of this video is missing: …" once the preview exists */
export const PREVIEW_READY_NOW = 'The preview is ready now. Try the analysis for this video again.'

/** the reason shown for a failed analysis (main's text, unless the preview is there by now) */
export function failureText(project: Project, videoId: string): string {
  const analysis = project.status[videoId]?.analysis
  if (remedyOf(analysis) === 'prepare' && hasPreview(project, videoId)) return PREVIEW_READY_NOW
  return analysis?.error?.trim() || 'That didn’t work.'
}

/**
 * The button of a failed row: try again · open the settings (key, model, quota, billing – with a
 * second button to try again once that is fixed) · make the preview again and analyse · go to the
 * Videos step (the original is gone: only putting it back or removing the video helps there) ·
 * nothing (e.g. a safety block: the same video fails again).
 */
export type FailureAction = 'retry' | 'settings' | 'rebuild-preview' | 'go-videos' | null

export function failureAction(project: Project, videoId: string): FailureAction {
  const status = project.status[videoId]
  switch (currentRemedy(project, videoId)) {
    case 'retry':
      return 'retry'
    case 'settings':
      return 'settings'
    case 'prepare':
      return status?.prepare.status === 'error' && isMissingOriginal(status.prepare.error)
        ? 'go-videos'
        : 'rebuild-preview'
    default:
      return null
  }
}

export interface FailureOverview {
  /** videos whose analysis failed (stage 'error'), in project order */
  failedIds: string[]
  /** the subset where trying again can help right away (remedy 'retry') */
  retryIds: string[]
  /**
   * the subset that needs the settings first (key, model, quota, billing): tried again once that
   * is fixed – e.g. after switching the model, or the next day
   */
  settingsIds: string[]
  /** the reason when every failed video failed the same way, else null */
  sharedReason: string | null
  /** remedies of the failed videos, without duplicates */
  remedies: AnalysisRemedy[]
}

export function failureOverview(project: Project): FailureOverview {
  const failedIds: string[] = []
  const retryIds: string[] = []
  const settingsIds: string[] = []
  const reasons = new Set<string>()
  const remedies = new Set<AnalysisRemedy>()
  for (const video of project.videos) {
    const analysis = project.status[video.id]?.analysis
    if (analysis?.stage !== 'error') continue
    failedIds.push(video.id)
    const remedy = currentRemedy(project, video.id) ?? 'retry'
    remedies.add(remedy)
    if (remedy === 'retry') retryIds.push(video.id)
    if (remedy === 'settings') settingsIds.push(video.id)
    reasons.add(failureText(project, video.id))
  }
  return {
    failedIds,
    retryIds,
    settingsIds,
    sharedReason: reasons.size === 1 ? [...reasons][0] : null,
    remedies: [...remedies]
  }
}

// ---------------------------------------------------------------------------
// What a new analysis run does to the reel
// ---------------------------------------------------------------------------

/**
 * Videos a run would analyse – mirrors main: explicit ids, otherwise every video without a fresh
 * result (all with `force`). Without a hash every analysed video counts as fresh.
 */
export function analysisTargets(
  project: Project,
  currentHash: string | null,
  options: StartAnalysisOptions = {}
): string[] {
  if (options.videoIds !== undefined) {
    const wanted = new Set(options.videoIds)
    return project.videos.filter((video) => wanted.has(video.id)).map((video) => video.id)
  }
  const fresh = (videoId: string): boolean =>
    currentHash === null
      ? !!project.analyses[videoId] && !lastAttemptFailed(project, videoId)
      : isAnalysisFresh(project, videoId, currentHash)
  return project.videos
    .filter((video) => options.force === true || !fresh(video.id))
    .map((video) => video.id)
}

const TRIM_EPSILON = 0.005

/**
 * A clip whose in/out points the user changed. A trim by the automatic selection (to fill the
 * target length, marked with `autoTrimmedFrom`) does not count – the user's times are the ones from
 * before that trim. A clip without Gemini's times was added by hand in an older version: it counts.
 */
export function hasOwnTrim(moment: Moment): boolean {
  if (moment.aiStart === undefined || moment.aiEnd === undefined) return true
  const own = moment.autoTrimmedFrom ?? moment
  return (
    Math.abs(own.start - moment.aiStart) > TRIM_EPSILON ||
    Math.abs(own.end - moment.aiEnd) > TRIM_EPSILON
  )
}

export interface ReanalysisImpact {
  /** videos the run analyses – Gemini's new moments replace their moments */
  videos: number
  /** their clips in a reel edited by hand – they leave it */
  selected: number
  /** their clips with the user's own trim – the trims are lost */
  trimmed: number
  /** clips that stay in the reel (other videos) */
  kept: number
  /**
   * main puts the reel together automatically after the run: it is the automatic one
   * (reelEdited false), or none of its clips would be left
   */
  rebuilt: boolean
}

/**
 * What the user would lose by analysing `targetIds`; null when nothing made by hand is at stake.
 * An automatic reel (reelEdited false) is rebuilt after the run anyway, so only own trims of
 * replaced clips count. A reel edited by hand stays as it is, minus the clips of the analysed
 * videos – unless none of its clips would be left: then main puts it together automatically again.
 */
export function reanalysisImpact(
  project: Project,
  targetIds: readonly string[]
): ReanalysisImpact | null {
  const targets = new Set(targetIds)
  const replaced = project.moments.filter((m) => targets.has(m.videoId))
  const selected = project.reelEdited ? replaced.filter((m) => m.selected).length : 0
  const trimmed = replaced.filter(hasOwnTrim).length
  if (selected === 0 && trimmed === 0) return null
  const kept = project.moments.filter((m) => m.selected).length - selected
  return {
    videos: targets.size,
    selected,
    trimmed,
    kept,
    rebuilt: !project.reelEdited || kept === 0
  }
}

/**
 * While a run is going: does the reel stay as the user edited it? Only when it was edited by hand
 * and one of its clips survives the run (a clip of a video the run does not analyse); an empty
 * result is put together automatically again.
 */
export function reelKeptAfterRun(project: Project): boolean {
  if (!project.reelEdited) return false
  const inRun = new Set(
    project.videos
      .filter((video) => isRunningStage(stageOf(project, video)))
      .map((video) => video.id)
  )
  return project.moments.some((m) => m.selected && !inRun.has(m.videoId))
}

const SUGGESTIONS = '“More suggestions”'

/** Confirmation text for reanalysisImpact(): what gets replaced, what is lost, what stays */
export function describeReanalysis(impact: ReanalysisImpact): string {
  const { videos, selected, trimmed, kept } = impact
  const sentences = [
    videos === 1
      ? 'Gemini looks at the video again and replaces its earlier suggestions.'
      : `Gemini looks at ${videos} videos again and replaces their earlier suggestions.`
  ]
  const clips = selected === 1 ? '1 clip disappears' : `${selected} clips disappear`
  if (selected > 0 && trimmed > 0) {
    const trims =
      trimmed === 1 ? 'your trim on 1 clip is lost' : `your trims on ${trimmed} clips are lost`
    sentences.push(`${clips} from your highlight video, and ${trims}.`)
  } else if (selected > 0) {
    sentences.push(`${clips} from your highlight video.`)
  } else {
    const trims =
      trimmed === 1 ? 'Your trim on 1 clip is lost' : `Your trims on ${trimmed} clips are lost`
    sentences.push(`${trims}.`)
  }
  if (impact.rebuilt || kept === 0) {
    sentences.push('After that, your highlight video is put together again automatically.')
  } else if (selected === 0) {
    sentences.push(
      `Your highlight video stays as it is. You will find the new moments under ${SUGGESTIONS} afterwards.`
    )
  } else {
    const rest =
      kept === 1
        ? 'The remaining clip stays in your highlight video'
        : `The remaining ${kept} clips stay in your order`
    sentences.push(`${rest}, and you will find the new moments under ${SUGGESTIONS} afterwards.`)
  }
  return sentences.join(' ')
}
