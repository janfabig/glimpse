// Wires stores, jobs, broadcasts and IPC handlers together – without Electron, so it can be tested.
// src/main/index.ts supplies the Electron parts (window, dialogs, shell, safeStorage, protocol).

import type { InvokeMethod } from '@shared/ipc'
import type { PowerSaveBlocker } from 'electron'
import type { Analyzer, MediaService } from '../contracts'
import { CoreError } from './errors'
import { Broadcaster } from './ipc/broadcaster'
import { createIpcHandlers, type IpcDeps, type IpcHandlers } from './ipc/handlers'
import { JobManager } from './jobs/manager'
import type { AppLogger } from './log'
import { createAppPaths, resolveDefaultOutputDir, type AppPaths } from './paths'
import { ProjectStore, storeNoticeToast } from './project/store'
import { createMediaAllowList } from './protocol/allowList'
import type { MediaAllowList } from './protocol/mediaHandler'
import type { SecretCipher } from './settings/cipher'
import { SettingsStore } from './settings/store'

export interface CoreOptions {
  userData: string
  /** app.getPath('videos') – parent of the default export folder */
  videosDir: string
  env: NodeJS.ProcessEnv
  media: MediaService
  analyzer: Analyzer
  defaultModel: string
  cipher: SecretCipher
  log: Pick<AppLogger, 'info' | 'warn' | 'error' | 'addSecret'>
  /** delivers an event to every renderer */
  send(channel: string, payload: unknown): void
  /** Electron's powerSaveBlocker: held while jobs run */
  powerSaveBlocker: Pick<PowerSaveBlocker, 'start' | 'stop'>
}

export interface CoreRuntime {
  paths: AppPaths
  settings: SettingsStore
  store: ProjectStore
  jobs: JobManager
  broadcaster: Broadcaster
  isMediaAllowed: MediaAllowList
  /** the runtime adds the log file to `app` */
  createHandlers(
    electron: Pick<IpcDeps, 'dialogs' | 'shell'> & { app: Omit<IpcDeps['app'], 'logFile'> }
  ): IpcHandlers
  /** before quit: stop all jobs (kills ffmpeg), then write pending project changes */
  shutdown(): Promise<void>
}

const SHUTDOWN_TIMEOUT_MS = 5000

/** the calls that start background work (ffmpeg, Gemini) */
const STARTS_WORK: ReadonlySet<InvokeMethod> = new Set([
  'openProject',
  'addVideos',
  'retryPrepare',
  'startAnalysis',
  'analyzeAgain',
  'startExport'
])
const QUITTING_MESSAGE = 'Glimpse is quitting.'

/**
 * Every handler first runs `onCall` (the renderer that calls has subscribed to the events). While
 * the app quits, the calls that start work are refused: the window is still open, and an ffmpeg
 * started after the jobs were cancelled would run on without the app.
 */
function withCallHook(
  handlers: IpcHandlers,
  onCall: () => void,
  isQuitting: () => boolean
): IpcHandlers {
  const wrapped: Partial<Record<InvokeMethod, (...args: unknown[]) => unknown>> = {}
  for (const name of Object.keys(handlers) as InvokeMethod[]) {
    const handler = handlers[name] as (...args: unknown[]) => unknown
    wrapped[name] = (...args) => {
      onCall()
      if (isQuitting() && STARTS_WORK.has(name)) {
        return Promise.reject(new CoreError('busy', QUITTING_MESSAGE))
      }
      return handler(...args)
    }
  }
  return wrapped as unknown as IpcHandlers
}

export async function startCore(options: CoreOptions): Promise<CoreRuntime> {
  const { log } = options
  const paths = createAppPaths(options.userData)
  const settings = new SettingsStore({
    paths,
    cipher: options.cipher,
    defaults: {
      model: options.defaultModel,
      outputDir: resolveDefaultOutputDir(options.videosDir, options.env)
    },
    env: options.env,
    log,
    onSecret: (secret) => log.addSecret(secret)
  })
  await settings.init()
  // toasts wait until the renderer has called in: a project restored during init() is announced
  // as soon as there is someone to tell
  const broadcaster = new Broadcaster({ send: options.send, holdToasts: true })
  const store = new ProjectStore({
    paths,
    log,
    onNotice: (notice) => broadcaster.toast(storeNoticeToast(notice))
  })
  await store.init()

  store.subscribe((event) => {
    if (event.type === 'updated') broadcaster.projectUpdated(event.project)
    else broadcaster.projectDeleted(event.projectId)
  })
  let blockerId: number | undefined
  const jobs = new JobManager({
    store,
    settings,
    media: options.media,
    analyzer: options.analyzer,
    paths,
    log,
    notify: {
      toast: (event) => broadcaster.toast(event),
      exportProgress: (event) => broadcaster.exportProgress(event),
      flushProject: (projectId) => broadcaster.flushProject(projectId)
    },
    // nobody watches a long analysis or export: the Mac must not idle-sleep, the display may
    onBusyChange: (busy) => {
      if (busy) blockerId = options.powerSaveBlocker.start('prevent-app-suspension')
      else if (blockerId !== undefined) options.powerSaveBlocker.stop(blockerId)
    }
  })
  const isMediaAllowed = createMediaAllowList({
    projectsDir: paths.projectsDir,
    isKnownVideo: (path) => store.hasVideoPath(path)
  })

  let stopping: Promise<void> | null = null
  return {
    paths,
    settings,
    store,
    jobs,
    broadcaster,
    isMediaAllowed,
    createHandlers: (electron) =>
      withCallHook(
        createIpcHandlers({
          ...electron,
          app: { ...electron.app, logFile: paths.logFile },
          settings,
          store,
          jobs,
          media: options.media,
          analyzer: options.analyzer,
          log,
          onSecret: (secret) => log.addSecret(secret)
        }),
        () => broadcaster.markReady(),
        () => stopping !== null
      ),
    shutdown: () => {
      stopping ??= (async () => {
        jobs.cancelAll()
        // also waits for uploads that are being deleted on Google's side
        if (!(await jobs.whenIdle(SHUTDOWN_TIMEOUT_MS))) {
          log.warn('app', 'jobs did not stop in time')
        }
        await store.close()
        broadcaster.dispose()
        log.info('app', 'shut down')
      })()
      return stopping
    }
  }
}
