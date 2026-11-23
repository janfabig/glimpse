// Internal contracts between main-process modules:
//   media/  implements MediaService   (ffmpeg / ffprobe)
//   ai/     implements Analyzer       (Gemini, or a fake for tests)
//   core/   orchestrates both         (projects, jobs, IPC)
// Keep this file free of runtime dependencies on those modules.

import type {
  ApiKeyTestResult,
  BriefSettings,
  ExportSettings,
  FfmpegStatus,
  ModelOption,
  RemoteFileRef,
  SpriteInfo,
  TokenUsage
} from '@shared/types'

/** fraction: 0..1, or -1 when indeterminate */
export type ProgressFn = (fraction: number) => void

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export interface ProbeResult {
  durationSec: number
  /** display size (rotation applied) */
  width: number
  height: number
  fps: number
  videoCodec: string
  hasAudio: boolean
  /** ISO string from format/stream tag creation_time (or com.apple.quicktime.creationdate), else null */
  recordedAt: string | null
  sizeBytes: number
}

export interface RenderClip {
  /** original source file (not the proxy) */
  sourcePath: string
  start: number
  end: number
  hasAudio: boolean
  /** display size of the source (rotation applied) */
  sourceWidth: number
  sourceHeight: number
}

export interface RenderJob {
  clips: RenderClip[]
  settings: ExportSettings
  /** short side (pixels) and frame rate of the reel: the app passes EXPORT_FIXED, tests a small frame */
  frame: { shortSide: number; fps: number }
  outputPath: string
  /** scratch directory owned by this job; the media module may create files in it, core deletes it afterwards */
  workDir: string
}

export interface RenderProgress {
  phase: 'rendering' | 'joining' | 'finishing'
  /** 0-based index of the clip being rendered (phase 'rendering') */
  clipIndex?: number
  clipCount: number
  /** 0..1 overall progress of the whole render */
  fraction: number
}

export interface RenderResult {
  /**
   * the file actually written: it differs from `job.outputPath` by a " (n)" suffix when that name
   * was taken while the export ran (on APFS also by letter case or Unicode normalisation)
   */
  outputPath: string
  durationSec: number
  sizeBytes: number
}

export interface MediaService {
  /** locates ffmpeg/ffprobe and detects capabilities (cached after the first call) */
  status(): Promise<FfmpegStatus>
  probe(path: string): Promise<ProbeResult>
  /** `${size}-${mtimeMs}-${sha1(first+last MiB)}` */
  fingerprint(path: string): Promise<string>
  /** JPEG poster frame, longest side ≤ 640 px */
  makePoster(input: string, outPath: string, atSec: number): Promise<void>
  /** H.264/AAC MP4 proxy, short side 720 px (never upscaled), keyframe every ~1 s, faststart */
  makeProxy(
    input: string,
    outPath: string,
    opts: { durationSec: number; onProgress?: ProgressFn; signal?: AbortSignal }
  ): Promise<void>
  /** what Gemini gets: the proxy at 4 fps with mono 64 kbit/s audio, same picture and timeline */
  makeAnalysisCopy(input: string, outPath: string, opts: { signal?: AbortSignal }): Promise<void>
  /** single-row filmstrip JPEG (≤ 120 tiles) */
  makeSprite(
    input: string,
    outPath: string,
    opts: { durationSec: number; signal?: AbortSignal }
  ): Promise<SpriteInfo>
  renderHighlight(
    job: RenderJob,
    opts: { onProgress?: (p: RenderProgress) => void; signal?: AbortSignal }
  ): Promise<RenderResult>
}

// ---------------------------------------------------------------------------
// Analyzer (Gemini)
// ---------------------------------------------------------------------------

export type AnalyzeStage = 'uploading' | 'processing' | 'analyzing'

/** A clip of the video from before a second pass ("Ask Gemini again"), shown to Gemini again. */
export interface EarlierClip {
  /** seconds, as Gemini chose them (not the user's trims) */
  start: number
  end: number
  title: string
  score: number
  /** the clip was in the highlight video */
  inReel: boolean
}

export interface AnalyzeRequest {
  apiKey: string
  model: string
  video: {
    /** what gets uploaded: the analysis copy of the proxy (MediaService.makeAnalysisCopy) */
    proxyPath: string
    proxyFingerprint: string
    durationSec: number
    fileName: string
    recordedAt: string | null
  }
  brief: BriefSettings
  /** second pass only: the video's clips from before the run (none: a normal analysis) */
  earlierClips?: EarlierClip[]
  /** previously uploaded file – reuse when still valid and the fingerprint matches */
  remoteFile: RemoteFileRef | null
  /**
   * called once the uploaded or reused file is ACTIVE, before generation starts, so core can record
   * it in project.remoteFiles even when the analysis then fails or is cancelled
   */
  onRemoteFile: (file: RemoteFileRef) => void
  /**
   * receives background work the analyzer starts without waiting for it – deleting an upload that
   * nobody will use (Gemini was still processing it when the analysis failed or was cancelled, an
   * orphaned SDK upload) – so core can track it and quitting waits for it. The promise never
   * rejects. The analysis itself still ends right away.
   */
  onCleanup?: (cleanup: Promise<void>) => void
  /** progress: 0..1, or -1 when indeterminate */
  onStage: (stage: AnalyzeStage, progress: number) => void
  signal?: AbortSignal
}

export interface AnalyzedMoment {
  start: number
  end: number
  title: string
  reason: string
  score: number
}

export interface AnalyzeResponse {
  /** validated, clamped to the duration, non-overlapping, sorted by start */
  moments: AnalyzedMoment[]
  model: string
  usage: TokenUsage | null
  /**
   * the upload the analysis used: it always stays on Google's side, so the next analysis of the
   * video skips the upload (Google deletes it after about 48 hours)
   */
  remoteFile: RemoteFileRef
}

export interface Analyzer {
  analyze(req: AnalyzeRequest): Promise<AnalyzeResponse>
  listModels(apiKey: string): Promise<ModelOption[]>
  testKey(apiKey: string): Promise<ApiKeyTestResult>
  deleteRemoteFile(apiKey: string, name: string): Promise<void>
}

export type AnalyzerErrorCode =
  | 'auth'
  | 'quota'
  | 'safety'
  | 'invalid-response'
  | 'upload'
  | 'processing'
  | 'network'
  | 'model'
  | 'cancelled'
  | 'unknown'

/**
 * A Gemini file name as Google hands it out ("files/<id>"). Only such a name goes into an SDK
 * request path: one read from project.json could otherwise point the request at another resource.
 */
export function isGeminiFileName(name: string): boolean {
  return /^files\/[a-z0-9-]{1,40}$/.test(name)
}

/** a file uri on Google's Gemini host (what an upload returns) */
export function isGeminiFileUri(uri: string): boolean {
  return URL.parse(uri)?.origin === 'https://generativelanguage.googleapis.com'
}

/** Thrown by Analyzer implementations; `message` is user-facing. */
export class AnalyzerError extends Error {
  readonly code: AnalyzerErrorCode
  readonly retryable: boolean
  constructor(
    code: AnalyzerErrorCode,
    message: string,
    options?: { retryable?: boolean; cause?: unknown }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'AnalyzerError'
    this.code = code
    this.retryable = options?.retryable ?? false
  }
}

/** Thrown by MediaService implementations; `message` is user-facing. */
export class MediaError extends Error {
  readonly code: 'no-ffmpeg' | 'probe' | 'ffmpeg' | 'cancelled' | 'invalid'
  /** last lines of ffmpeg stderr, for logs */
  readonly details?: string
  constructor(code: MediaError['code'], message: string, details?: string) {
    super(message)
    this.name = 'MediaError'
    this.code = code
    this.details = details
  }
}
