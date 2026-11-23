// IPC contract between renderer (window.api) and main.
// The preload maps every HighlightApi method 1:1 to the channel with the same name.

import type {
  AddVideosResult,
  ApiKeyTestResult,
  AppInfo,
  AppSettings,
  ExportProgress,
  ModelOption,
  Project,
  ProjectId,
  ProjectMutation,
  ProjectSummary,
  SettingsPatch,
  ToastEvent,
  Unsubscribe,
  VideoId
} from './types'

/** invoke channels (renderer → main, request/response via ipcRenderer.invoke / ipcMain.handle) */
export const IPC = {
  getAppInfo: 'app:getInfo',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  testApiKey: 'settings:testApiKey',
  listModels: 'settings:listModels',
  listProjects: 'projects:list',
  createProject: 'projects:create',
  openProject: 'projects:open',
  deleteProject: 'projects:delete',
  mutateProject: 'projects:mutate',
  pickVideoFiles: 'videos:pick',
  addVideos: 'videos:add',
  removeVideo: 'videos:remove',
  retryPrepare: 'videos:retryPrepare',
  startAnalysis: 'analysis:start',
  analyzeAgain: 'analysis:again',
  cancelAnalysis: 'analysis:cancel',
  autoSelect: 'moments:autoSelect',
  chooseOutputDir: 'export:chooseDir',
  startExport: 'export:start',
  cancelExport: 'export:cancel',
  showInFinder: 'shell:showInFinder',
  openFile: 'shell:openFile',
  openOriginal: 'shell:openOriginal',
  openExternal: 'shell:openExternal'
} as const

/** event channels (main → renderer via webContents.send) */
export const IPC_EVENTS = {
  projectUpdated: 'event:projectUpdated',
  exportProgress: 'event:exportProgress',
  toast: 'event:toast'
} as const

/**
 * ToastEvent.key values: a toast with the same key replaces the earlier one, and the renderer
 * closes a project's failure toast when it starts the next run or export of that project.
 */
export const TOAST_KEYS = {
  /** "Your changes cannot be saved right now. …" and "Everything is saved again." */
  projectSave: 'project-save',
  /** failed videos at the end of a project's analysis run */
  analysisFailed: (projectId: string): string => `analysis-failed:${projectId}`,
  /** a project's failed export */
  exportFailed: (projectId: string): string => `export-failed:${projectId}`
} as const

/**
 * One-way channel of the preload itself (ipcRenderer.send, not part of window.api): every path
 * getPathForFile resolves – a file or folder the user dropped – is reported, so main lists only
 * folders the user handed over (dropped, or picked in the dialog).
 */
export const IPC_HANDED_OVER = 'videos:handedOver'

export interface StartAnalysisOptions {
  /** default: every video whose analysis is missing, failed, cancelled or stale for the current brief */
  videoIds?: VideoId[]
  /** re-analyse even if a fresh result exists */
  force?: boolean
}

/** The API exposed to the renderer as `window.api`. */
export interface HighlightApi {
  // app & settings
  getAppInfo(): Promise<AppInfo>
  getSettings(): Promise<AppSettings>
  updateSettings(patch: SettingsPatch): Promise<AppSettings>
  /** tests the given key, or the stored one when omitted */
  testApiKey(apiKey?: string): Promise<ApiKeyTestResult>
  listModels(): Promise<ModelOption[]>

  // projects
  listProjects(): Promise<ProjectSummary[]>
  createProject(name?: string): Promise<Project>
  openProject(id: ProjectId): Promise<Project>
  deleteProject(id: ProjectId): Promise<void>
  mutateProject(id: ProjectId, mutation: ProjectMutation): Promise<Project>

  // videos
  /** native multi-select open dialog filtered to video files; [] when cancelled */
  pickVideoFiles(): Promise<string[]>
  /** probes the files, creates posters and starts background preparation (proxy + filmstrip) */
  addVideos(id: ProjectId, paths: string[]): Promise<AddVideosResult>
  removeVideo(id: ProjectId, videoId: VideoId): Promise<Project>
  retryPrepare(id: ProjectId, videoId: VideoId): Promise<void>
  /** absolute path of a File from a drag & drop event (synchronous, via webUtils) */
  getPathForFile(file: File): string

  // analysis
  /** resolves once the jobs are queued; progress arrives via onProjectUpdated */
  startAnalysis(id: ProjectId, options?: StartAnalysisOptions): Promise<void>
  /**
   * "Ask Gemini again", one step in main: `wish` becomes the last line of the prompt, then
   * every video is analysed again – Gemini sees its earlier clips, and its new ones replace them.
   * Resolves like startAnalysis.
   */
  analyzeAgain(id: ProjectId, wish: string): Promise<void>
  cancelAnalysis(id: ProjectId): Promise<void>
  /** re-runs the automatic selection for the brief's target duration */
  autoSelect(id: ProjectId): Promise<Project>

  // export
  chooseOutputDir(): Promise<string | null>
  /** resolves once the export started; progress arrives via onExportProgress */
  startExport(id: ProjectId): Promise<{ exportId: string }>
  cancelExport(id: ProjectId): Promise<void>

  // shell
  showInFinder(path: string): Promise<void>
  openFile(path: string): Promise<void>
  /** plays a video's original in the Mac's default app – main looks its path up */
  openOriginal(id: ProjectId, videoId: VideoId): Promise<void>
  /** only https URLs on an allow-list (e.g. aistudio.google.com) */
  openExternal(url: string): Promise<void>

  // events
  onProjectUpdated(cb: (project: Project) => void): Unsubscribe
  onExportProgress(cb: (event: ExportProgress) => void): Unsubscribe
  onToast(cb: (event: ToastEvent) => void): Unsubscribe
}

/** invoke-style methods (everything except the synchronous helpers and event subscriptions) */
export type InvokeMethod = keyof typeof IPC

/**
 * Errors thrown by main-process handlers reach the renderer as `Error` with this prefix in the message,
 * followed by a JSON payload. Use parseIpcError() in the renderer.
 */
export const IPC_ERROR_PREFIX = 'HC_ERROR:'

export type IpcErrorCode =
  'no-api-key' | 'no-ffmpeg' | 'not-found' | 'busy' | 'invalid' | 'nothing-selected' | 'internal'

export interface IpcErrorPayload {
  code: IpcErrorCode
  /** user-facing */
  message: string
}

export function encodeIpcError(payload: IpcErrorPayload): string {
  return IPC_ERROR_PREFIX + JSON.stringify(payload)
}

/** Extracts the structured error from an Error thrown by ipcRenderer.invoke (Electron wraps the message). */
export function parseIpcError(err: unknown): IpcErrorPayload {
  const raw = err instanceof Error ? err.message : String(err)
  const idx = raw.indexOf(IPC_ERROR_PREFIX)
  if (idx >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(idx + IPC_ERROR_PREFIX.length)) as IpcErrorPayload
      if (parsed && typeof parsed.message === 'string') return parsed
    } catch {
      // fall through
    }
  }
  return { code: 'internal', message: 'Unexpected error: ' + raw }
}
