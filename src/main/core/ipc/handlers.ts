// One handler per invoke method of HighlightApi. Plain functions with injected dependencies –
// the Electron wiring lives in register.ts and src/main/index.ts.

import type { HighlightApi, InvokeMethod } from '@shared/ipc'
import type { ApiKeyTestResult, AppSettings, ModelOption, SettingsPatch } from '@shared/types'
import { normalize } from 'node:path'
import type { Analyzer, MediaService } from '../../contracts'
import { fail, isAnalyzerError } from '../errors'
import { isFile, isPathInside, pathExists } from '../fsx'
import type { JobManager } from '../jobs/manager'
import { JOB_MESSAGES } from '../jobs/messages'
import type { Logger } from '../log'
import { applyMutation } from '../mutations'
import { DEFAULT_PROJECT_NAME } from '../project/defaults'
import type { ProjectStore } from '../project/store'
import { isAllowedExternalUrl } from './security'
import {
  absolutePathArg,
  mutationArg,
  optionalApiKeyArg,
  optionalNameArg,
  pathListArg,
  projectIdArg,
  settingsPatchArg,
  startAnalysisOptionsArg,
  urlArg,
  videoIdArg,
  wishArg
} from './validate'

export interface SettingsAccess {
  getAppSettings(): AppSettings
  getApiKey(): Promise<string | null>
  update(patch: SettingsPatch): Promise<AppSettings>
  /** Google accepted or rejected this key (AppSettings.apiKeyRejected) */
  reportKeyCheck?(apiKey: string, accepted: boolean): void
}

export interface IpcDeps {
  settings: SettingsAccess
  store: ProjectStore
  jobs: JobManager
  media: Pick<MediaService, 'status'>
  analyzer: Pick<Analyzer, 'testKey' | 'listModels'>
  /** logFile: the main log, which showInFinder may reveal (Settings → System) */
  app: { version: string; userDataDir: string; logFile: string }
  dialogs: {
    /** absolute paths, [] when cancelled */
    pickVideoFiles(): Promise<string[]>
    chooseDirectory(): Promise<string | null>
  }
  shell: {
    showItemInFolder(path: string): void
    /** resolves with an error message, '' on success (Electron's shell.openPath) */
    openPath(path: string): Promise<string>
    openExternal(url: string): Promise<void>
  }
  log: Logger
  /** a key the user typed for testing – registered so logs can redact it */
  onSecret?: (secret: string) => void
}

export type IpcHandlers = {
  [K in InvokeMethod]: (...args: unknown[]) => ReturnType<HighlightApi[K]>
}

export const IPC_MESSAGES = {
  noStoredKey: 'No API key has been added yet.',
  noKeyForModels: 'Add your Gemini API key first.',
  keyTestFailed: 'The API key could not be checked. Check your internet connection and try again.',
  fileMissing: 'The file was not found. Was it moved or deleted?',
  fileNotAllowed: 'This file cannot be opened.',
  locationNotAllowed: 'This place cannot be shown in Finder.',
  openFailed: 'The file could not be opened.',
  linkNotAllowed: 'This link cannot be opened.'
} as const

export function createIpcHandlers(deps: IpcDeps): IpcHandlers {
  /** the key is missing – or stored, but the Keychain no longer hands it out */
  function missingKeyMessage(fallback: string): string {
    return deps.settings.getAppSettings().apiKeyUnreadable
      ? JOB_MESSAGES.apiKeyUnreadable
      : fallback
  }

  async function testApiKey(candidate: string | undefined): Promise<ApiKeyTestResult> {
    const key = candidate || (await deps.settings.getApiKey())
    if (!key) return { ok: false, message: missingKeyMessage(IPC_MESSAGES.noStoredKey) }
    if (candidate) deps.onSecret?.(candidate)
    try {
      const result = await deps.analyzer.testKey(key)
      // Settings shows a rejected key in use as rejected, not as "Connected"
      if (result.ok || result.rejected) deps.settings.reportKeyCheck?.(key, result.ok)
      return result
    } catch (err) {
      if (isAnalyzerError(err)) return { ok: false, message: err.message }
      deps.log.error('ipc', 'testing the API key failed', { err })
      return { ok: false, message: IPC_MESSAGES.keyTestFailed }
    }
  }

  async function listModels(): Promise<ModelOption[]> {
    const key = await deps.settings.getApiKey()
    if (!key && !deps.settings.getAppSettings().fakeAi) {
      fail('no-api-key', missingKeyMessage(IPC_MESSAGES.noKeyForModels))
    }
    return deps.analyzer.listModels(key ?? '')
  }

  async function openPath(path: string): Promise<void> {
    const error = await deps.shell.openPath(path)
    if (error) {
      deps.log.warn('ipc', 'opening a file failed', { path, error })
      fail('internal', IPC_MESSAGES.openFailed)
    }
  }

  /** exports, originals, the output folders and the log file – nothing else is revealed in Finder */
  function isRevealable(path: string): boolean {
    if (deps.store.hasExportPath(path) || deps.store.hasVideoPath(path)) return true
    if (normalize(deps.app.logFile) === path) return true
    const folders = [
      deps.settings.getAppSettings().defaultOutputDir,
      ...deps.store.all().map((project) => project.exportSettings.outputDir)
    ].filter((dir): dir is string => dir !== null)
    return folders.some((dir) => normalize(dir) === path || isPathInside(path, dir))
  }

  return {
    getAppInfo: async () => ({
      version: deps.app.version,
      ffmpeg: await deps.media.status(),
      userDataDir: deps.app.userDataDir,
      logFile: deps.app.logFile
    }),
    getSettings: async () => deps.settings.getAppSettings(),
    updateSettings: async (patch) => deps.settings.update(settingsPatchArg(patch)),
    testApiKey: async (apiKey) => testApiKey(optionalApiKeyArg(apiKey)),
    listModels: async () => listModels(),

    listProjects: async () => deps.store.list(),
    createProject: async (name) => deps.store.create(optionalNameArg(name) ?? DEFAULT_PROJECT_NAME),
    openProject: async (id) => deps.jobs.openProject(projectIdArg(id)),
    deleteProject: async (id) => deps.jobs.deleteProject(projectIdArg(id)),
    mutateProject: async (id, mutation) => {
      const projectId = projectIdArg(id)
      const change = mutationArg(mutation)
      return deps.store.update(projectId, (project) => applyMutation(project, change))
    },

    pickVideoFiles: async () => {
      const paths = await deps.dialogs.pickVideoFiles()
      // the user chose them: a picked folder may be listed (addVideos)
      deps.jobs.grantPaths(paths)
      return paths
    },
    addVideos: async (id, paths) => deps.jobs.addVideos(projectIdArg(id), pathListArg(paths)),
    removeVideo: async (id, videoId) =>
      deps.jobs.removeVideo(projectIdArg(id), videoIdArg(videoId)),
    retryPrepare: async (id, videoId) =>
      deps.jobs.retryPrepare(projectIdArg(id), videoIdArg(videoId)),

    startAnalysis: async (id, options) =>
      deps.jobs.startAnalysis(projectIdArg(id), startAnalysisOptionsArg(options)),
    analyzeAgain: async (id, wish) => deps.jobs.analyzeAgain(projectIdArg(id), wishArg(wish)),
    cancelAnalysis: async (id) => deps.jobs.cancelAnalysis(projectIdArg(id)),
    autoSelect: async (id) => deps.jobs.autoSelect(projectIdArg(id)),

    chooseOutputDir: async () => deps.dialogs.chooseDirectory(),
    startExport: async (id) => deps.jobs.startExport(projectIdArg(id)),
    cancelExport: async (id) => deps.jobs.cancelExport(projectIdArg(id)),

    showInFinder: async (rawPath) => {
      const path = absolutePathArg(rawPath)
      if (!isRevealable(path)) fail('invalid', IPC_MESSAGES.locationNotAllowed)
      if (!(await pathExists(path))) fail('not-found', IPC_MESSAGES.fileMissing)
      deps.shell.showItemInFolder(path)
    },
    openFile: async (rawPath) => {
      const path = absolutePathArg(rawPath)
      // only our exports – never arbitrary files or apps; originals go through openOriginal (ids)
      if (!deps.store.hasExportPath(path)) fail('invalid', IPC_MESSAGES.fileNotAllowed)
      if (!(await isFile(path))) fail('not-found', IPC_MESSAGES.fileMissing)
      await openPath(path)
    },
    openOriginal: async (id, rawVideoId) => {
      const projectId = projectIdArg(id)
      const videoId = videoIdArg(rawVideoId)
      const video = deps.store.get(projectId).videos.find((v) => v.id === videoId)
      if (!video) fail('not-found', JOB_MESSAGES.videoNotFound)
      if (!(await isFile(video.path))) {
        fail('not-found', JOB_MESSAGES.missingOriginal(video.fileName))
      }
      await openPath(video.path)
    },
    openExternal: async (rawUrl) => {
      const url = urlArg(rawUrl)
      if (!isAllowedExternalUrl(url)) fail('invalid', IPC_MESSAGES.linkNotAllowed)
      await deps.shell.openExternal(url)
    }
  }
}
