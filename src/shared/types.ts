// Domain types shared by main, preload and renderer.
// This file is the contract between modules – change it only deliberately (see docs/ARCHITECTURE.md).

export type ProjectId = string
export type VideoId = string
export type MomentId = string

/** ISO 8601 timestamp string, e.g. "2026-07-12T21:14:05.000Z" */
export type IsoDate = string

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------

export interface SpriteInfo {
  /** number of tiles in the single-row filmstrip image */
  columns: number
  /** seconds of source time between two tiles (tile i shows t = i * intervalSec) */
  intervalSec: number
  tileWidth: number
  tileHeight: number
}

export interface VideoInfo {
  id: VideoId
  /** absolute path of the original file (never modified) */
  path: string
  fileName: string
  sizeBytes: number
  durationSec: number
  /** display size, rotation already applied */
  width: number
  height: number
  hasAudio: boolean
  /** recording time from container metadata (creation_time), else file birth time */
  recordedAt: IsoDate | null
  /** `${size}-${mtimeMs}-${sha1(first+last MiB)}` – detects changed/duplicate files */
  fingerprint: string
  /** H.264 preview/upload proxy (short side 720 px); null until prepared */
  proxyPath: string | null
  /** poster frame JPEG */
  posterPath: string | null
  /** filmstrip sprite JPEG for the trim timeline; null until prepared */
  spritePath: string | null
  spriteInfo: SpriteInfo | null
}

export type PrepareStatus = 'pending' | 'running' | 'done' | 'error'

export type AnalysisStage =
  | 'idle'
  | 'queued'
  | 'waiting-proxy'
  | 'uploading'
  | 'processing'
  | 'analyzing'
  | 'done'
  | 'error'
  | 'cancelled'

export interface VideoStatus {
  prepare: { status: PrepareStatus; progress: number; error?: string }
  analysis: {
    stage: AnalysisStage
    /** 0..1 within the current stage; -1 = indeterminate */
    progress: number
    /** user-facing */
    message?: string
    /** user-facing */
    error?: string
    /** set together with stage 'error': what can help the user */
    remedy?: AnalysisRemedy
    startedAt?: IsoDate
    finishedAt?: IsoDate
  }
}

/**
 * 'retry': a temporary problem, trying again can work · 'settings': API key, model, quota or billing
 * need a change in the settings · 'prepare': the preview is missing, rebuild it in the Videos step ·
 * 'none': trying the same video again will not help (e.g. a safety block)
 */
export type AnalysisRemedy = 'retry' | 'settings' | 'prepare' | 'none'

// ---------------------------------------------------------------------------
// Moments (highlight segments)
// ---------------------------------------------------------------------------

export interface Moment {
  id: MomentId
  videoId: VideoId
  /** seconds on the source video's timeline */
  start: number
  end: number
  /** short (≤ 6 words) */
  title: string
  /** one sentence: why this is a highlight */
  reason: string
  /** 1..10 fit to the brief */
  score: number
  /** included in the highlight reel */
  selected: boolean
  /** the AI's original in/out points, kept so the user can reset a trim */
  aiStart?: number
  aiEnd?: number
  /**
   * the times before autoSelect trimmed this moment to fill the target length; the next
   * autoSelect restores them first. Dropped as soon as the user edits or resets the times.
   */
  autoTrimmedFrom?: { start: number; end: number }
}

export interface TokenUsage {
  promptTokens: number
  outputTokens: number
  thoughtsTokens: number
  totalTokens: number
}

export interface VideoAnalysis {
  videoId: VideoId
  model: string
  /** hash of the prompt and the model – detects stale results */
  briefHash: string
  createdAt: IsoDate
}

/** A file uploaded to the Gemini Files API (kept ~48 h by Google) */
export interface RemoteFileRef {
  /** e.g. "files/abc123" */
  name: string
  uri: string
  mimeType: string
  expiresAt: IsoDate | null
  /** fingerprint of the uploaded file: the proxy's analysis copy (older projects: the proxy) */
  proxyFingerprint: string
}

// ---------------------------------------------------------------------------
// Settings per project
// ---------------------------------------------------------------------------

export interface BriefSettings {
  /** the user's free-text prompt (any language) */
  prompt: string
  /** desired total reel length; null = no limit (take all strong moments) */
  targetDurationSec: number | null
}

export type AspectRatio = 'source' | '9:16' | '4:5' | '1:1' | '16:9'
export type FitMode = 'crop' | 'blur'
export type TransitionType = 'cut' | 'crossfade'

/** The choices of the export step; everything else is fixed (EXPORT_FIXED in presets.ts). */
export interface ExportSettings {
  aspect: AspectRatio
  /** how a source that does not match the target aspect is mapped: crop to fill, or fit on a blurred copy */
  fit: FitMode
  transition: TransitionType
  /** null = app default (~/Movies/Glimpse) */
  outputDir: string | null
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export interface ExportRecord {
  id: string
  path: string
  createdAt: IsoDate
  durationSec: number
  clipCount: number
  sizeBytes: number
}

export interface Project {
  schemaVersion: 1
  id: ProjectId
  name: string
  createdAt: IsoDate
  updatedAt: IsoDate
  /** sorted chronologically (recordedAt, then fileName) */
  videos: VideoInfo[]
  status: Record<VideoId, VideoStatus>
  brief: BriefSettings
  analyses: Record<VideoId, VideoAnalysis>
  remoteFiles: Record<VideoId, RemoteFileRef>
  /** array order = output order; the reel contains the selected moments in this order */
  moments: Moment[]
  /**
   * true once the user changed the reel by hand (selection, order, trims) since the last
   * automatic selection. Analysis runs then keep the reel and add their moments as suggestions;
   * every autoSelect resets it.
   */
  reelEdited: boolean
  exportSettings: ExportSettings
  exports: ExportRecord[]
}

export interface ProjectSummary {
  id: ProjectId
  name: string
  createdAt: IsoDate
  updatedAt: IsoDate
  videoCount: number
  totalDurationSec: number
  momentCount: number
  selectedCount: number
  posterPath: string | null
  lastExportPath: string | null
}

/** All renderer-initiated edits of a project go through these mutations (applied in main). */
export type ProjectMutation =
  | { type: 'rename'; name: string }
  | { type: 'setBrief'; patch: Partial<BriefSettings> }
  | { type: 'setExportSettings'; patch: Partial<ExportSettings> }
  | { type: 'toggleMoment'; momentId: MomentId; selected: boolean }
  | { type: 'updateMomentTimes'; momentId: MomentId; start: number; end: number }
  | { type: 'resetMomentTimes'; momentId: MomentId }
  /** toIndex = target position among the SELECTED moments (0-based, computed after removing the moved one) */
  | { type: 'reorderMoment'; momentId: MomentId; toIndex: number }

// ---------------------------------------------------------------------------
// App settings
// ---------------------------------------------------------------------------

export interface AppSettings {
  /** Gemini model id used for new analyses */
  model: string
  hasApiKey: boolean
  apiKeySource: 'keychain' | 'env' | null
  /** a key is stored but can no longer be decrypted (Keychain access denied or item gone) */
  apiKeyUnreadable?: boolean
  /**
   * Google rejected the key in use during an analysis or a key test of this session (deleted or
   * revoked in AI Studio); cleared when a key is stored or removed or Google accepts it again
   */
  apiKeyRejected?: boolean
  /** default folder for exports */
  defaultOutputDir: string
  /** true when HC_FAKE_AI=1 (tests / demos without API key) */
  fakeAi: boolean
}

export interface SettingsPatch {
  model?: string
  /** string = store in Keychain-backed safeStorage, null = delete */
  apiKey?: string | null
  defaultOutputDir?: string
}

export interface ModelOption {
  id: string
  displayName: string
  description?: string
  recommended?: boolean
}

export interface ApiKeyTestResult {
  ok: boolean
  /** user-facing */
  message: string
  models?: ModelOption[]
  /** not ok because Google rejected the key itself (not e.g. a network problem) */
  rejected?: boolean
}

export interface FfmpegStatus {
  ok: boolean
  ffmpegPath: string | null
  ffprobePath: string | null
  version: string | null
  hardwareEncoders: string[]
  /** user-facing hint when !ok */
  error?: string
}

export interface AppInfo {
  version: string
  ffmpeg: FfmpegStatus
  userDataDir: string
  /** absolute path of the main log file; showInFinder accepts it */
  logFile: string
}

// ---------------------------------------------------------------------------
// Results & events
// ---------------------------------------------------------------------------

export interface AddVideosResult {
  project: Project
  added: number
  /** files that were not added, with a reason for the user (duplicate, not a video, unreadable …) */
  skipped: { path: string; reason: string }[]
}

export type ExportPhase =
  'preparing' | 'rendering' | 'joining' | 'finishing' | 'done' | 'error' | 'cancelled'

export interface ExportProgress {
  projectId: ProjectId
  exportId: string
  phase: ExportPhase
  /** 0..1 overall */
  progress: number
  /** 1-based index of the clip being rendered */
  currentClip?: number
  clipCount?: number
  /** user-facing */
  message?: string
  outputPath?: string
  /** user-facing */
  error?: string
}

export interface ToastEvent {
  level: 'info' | 'success' | 'warning' | 'error'
  /** user-facing */
  message: string
  /**
   * the project it is about (the end of its analysis run or export, a relink): the renderer closes
   * it when the user opens another project or the start screen, and names the project when it is
   * not open
   */
  projectId?: ProjectId
  /** stays until the user closes it instead of a reading time – for failures nobody may miss */
  sticky?: boolean
  /** a later toast with the same key replaces this one (e.g. "saved again" closes "not saved") */
  key?: string
}

export type Unsubscribe = () => void
