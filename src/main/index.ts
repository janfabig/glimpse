// Main-process bootstrap (docs/ARCHITECTURE.md §5). Electron-specific glue only – the logic lives
// in src/main/core.

// Must stay the first import: applies HC_USER_DATA_DIR and the app name before anything else runs.
import { movedLegacyData, userDataOverride } from './core/early'

import { VIDEO_EXTENSIONS } from '@shared/presets'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  powerMonitor,
  powerSaveBlocker,
  screen,
  session,
  shell,
  type OpenDialogOptions
} from 'electron'
import { dirname, join } from 'node:path'
import { createAnalyzer, DEFAULT_MODEL } from './ai'
import type { Analyzer } from './contracts'
import { APP_NAME, assertIsolatedE2eProfile } from './core/appIdentity'
import { registerHandedOverPaths, registerIpcHandlers } from './core/ipc/register'
import {
  createAppUrlMatcher,
  createSenderValidator,
  isAllowedExternalUrl
} from './core/ipc/security'
import { log } from './core/log'
import { applicationMenuTemplate } from './core/menu'
import { createAppPaths } from './core/paths'
import { quitStep } from './core/quit'
import {
  installMediaProtocol,
  installRendererFileProtocol,
  registerMediaSchemePrivileges
} from './core/protocol/register'
import { startCore, type CoreRuntime } from './core/runtime'
import { createE2eCipher } from './core/settings/e2eCipher'
import { safeStorageCipher } from './core/settings/safeStorageCipher'
import { createUnavailableAnalyzer } from './core/unavailableAnalyzer'
import { appFfmpegDirs, createMediaService } from './media'

/** E2E runs keep the window hidden – nothing pops up on the desktop */
const E2E = process.env.HC_E2E === '1'
const DEV_SERVER_URL = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
const INDEX_HTML = join(__dirname, '../renderer/index.html')
const PRELOAD = join(__dirname, '../preload/index.js')
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write'])

const isAppUrl = createAppUrlMatcher({ devServerUrl: DEV_SERVER_URL, indexHtml: INDEX_HTML })
const windows = new Set<BrowserWindow>()
let core: CoreRuntime | null = null
let quitReady = false
/** the user chose "Quit" although an analysis or export was running */
let quitConfirmed = false
let askingToQuit = false
/**
 * logout, restart or shutdown: never hold the system up with a question. shortcut: stays set when
 * another app cancels the logout (a later ⌘Q then quits without asking), fine for a rare case.
 */
let systemQuit = false

const isTrustedSender = createSenderValidator({
  isAppUrl,
  isOwnWebContents: (id) =>
    [...windows].some((win) => !win.isDestroyed() && win.webContents.id === id)
})

registerMediaSchemePrivileges()

function broadcast(channel: string, payload: unknown): void {
  for (const win of windows) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function parentWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? [...windows].find((win) => !win.isDestroyed())
}

async function showOpenDialog(options: OpenDialogOptions): Promise<string[]> {
  const parent = parentWindow()
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? [] : result.filePaths
}

function createAnalyzerSafely(): Analyzer {
  const fake = process.env.HC_FAKE_AI === '1'
  try {
    return createAnalyzer({
      fake,
      logger: {
        info: (message, data) => log.info('ai', message, data),
        warn: (message, data) => log.warn('ai', message, data)
      }
    })
  } catch (err) {
    log.error('app', 'analyzer could not be created – analysis disabled', { err, fake })
    return createUnavailableAnalyzer()
  }
}

function hardenSessions(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
    ALLOWED_PERMISSIONS.has(permission)
  )
}

/** the window colour behind the page: --bg of the current theme (renderer styles/tokens.css) */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#141414' : '#eeeeee'
}

function createWindow(): BrowserWindow {
  // open filling the screen (without the menu bar and the Dock)
  const { workArea } = screen.getPrimaryDisplay()
  const win = new BrowserWindow({
    ...workArea,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    title: APP_NAME,
    titleBarStyle: 'hiddenInset',
    // Centres the 14 px traffic lights in the renderer's 52 px top bar (--topbar-h): y = (52 - 14) / 2.
    // hiddenInset alone puts them at y 11 (8 px too high); x 12 is its own inset, so the buttons end
    // at 72 px and the top bar's 84 px left padding (--traffic-lights) still fits.
    trafficLightPosition: { x: 12, y: 19 },
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // a hidden E2E window must not have its timers throttled
      backgroundThrottling: !E2E
    }
  })
  windows.add(win)
  win.on('closed', () => {
    windows.delete(win)
    // the app keeps running windowless: a toast now would reach nobody
    if (windows.size === 0) core?.broadcaster.holdToasts()
  })
  win.once('ready-to-show', () => {
    if (!E2E) win.show()
  })

  const contents = win.webContents
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  const blockForeignNavigation = (event: { url: string; preventDefault(): void }): void => {
    if (isAppUrl(event.url)) return
    event.preventDefault()
    log.warn('window', 'navigation blocked', { url: event.url })
  }
  contents.on('will-navigate', blockForeignNavigation)
  contents.on('will-redirect', blockForeignNavigation)
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.on('render-process-gone', (_event, details) =>
    log.error('window', 'renderer gone', details)
  )

  if (DEV_SERVER_URL) void win.loadURL(DEV_SERVER_URL)
  else void win.loadFile(INDEX_HTML)
  return win
}

async function main(): Promise<void> {
  // before the log file or the stores touch the profile
  assertIsolatedE2eProfile(E2E, userDataOverride)
  if (E2E) app.dock?.hide()
  const userData = app.getPath('userData')
  log.attachFile(createAppPaths(userData).logFile)
  log.info('app', 'starting', {
    version: app.getVersion(),
    electron: process.versions.electron,
    e2e: E2E,
    fakeAi: process.env.HC_FAKE_AI === '1'
  })
  if (movedLegacyData) log.info('app', 'moved the data of the former name over')
  hardenSessions()
  app.setAboutPanelOptions({ applicationName: APP_NAME })
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      applicationMenuTemplate({ appName: APP_NAME, isPackaged: app.isPackaged })
    )
  )
  // file:// serves the renderer bundle only (the dev server is http and needs no guard)
  if (!DEV_SERVER_URL) installRendererFileProtocol(dirname(INDEX_HTML), log)

  const media = createMediaService({
    // packaged: only the ffmpeg inside the app; development and E2E: the repo's vendor/ffmpeg first
    ...appFfmpegDirs({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    }),
    logger: {
      warn: (message, details) => log.warn('media', message, details ? { details } : undefined)
    }
  })
  core = await startCore({
    userData,
    videosDir: app.getPath('videos'),
    env: process.env,
    media,
    analyzer: createAnalyzerSafely(),
    defaultModel: DEFAULT_MODEL,
    // E2E runs (always on an isolated profile, see above) must never prompt for the Keychain
    cipher: E2E ? createE2eCipher(userData) : safeStorageCipher,
    log,
    send: broadcast,
    powerSaveBlocker
  })
  // emitted before the quit on logout, restart and shutdown (NSWorkspaceWillPowerOffNotification)
  powerMonitor.on('shutdown', () => {
    systemQuit = true
  })
  installMediaProtocol(core.isMediaAllowed, log)
  const handlers = core.createHandlers({
    app: { version: app.getVersion(), userDataDir: userData },
    dialogs: {
      // files or folders: addVideos takes the videos inside a folder (one level)
      pickVideoFiles: () =>
        showOpenDialog({
          title: 'Add videos',
          buttonLabel: 'Add',
          // the panel's Photos section waits for iCloud downloads and may hand over temporary copies
          message:
            'Videos from the Photos app: export them there first with File › Export › Export Unmodified Original.',
          properties: ['openFile', 'openDirectory', 'multiSelections'],
          filters: [{ name: 'Videos', extensions: [...VIDEO_EXTENSIONS] }]
        }),
      chooseDirectory: async () => {
        const [dir] = await showOpenDialog({
          title: 'Choose export folder',
          buttonLabel: 'Choose',
          properties: ['openDirectory', 'createDirectory']
        })
        return dir ?? null
      }
    },
    shell: {
      showItemInFolder: (path) => shell.showItemInFolder(path),
      openPath: (path) => shell.openPath(path),
      openExternal: (url) => shell.openExternal(url)
    }
  })
  registerIpcHandlers(ipcMain, handlers, { isTrustedSender, log })
  const jobs = core.jobs
  registerHandedOverPaths(ipcMain, (path) => jobs.grantPaths([path]), { isTrustedSender, log })
  nativeTheme.on('updated', () => {
    for (const w of windows) if (!w.isDestroyed()) w.setBackgroundColor(windowBackground())
  })
  const win = createWindow()
  // a packaged start has no DevTools, also with HC_E2E: build/verify-package.mjs waits for this line
  if (E2E && app.isPackaged) void logWhenUiReady(win, media)
}

/** logs "ui ready" with the ffmpeg in use once the page has loaded its data (body[data-ready]) */
async function logWhenUiReady(
  win: BrowserWindow,
  media: { status(): Promise<unknown> }
): Promise<void> {
  const isReady = (): Promise<boolean> =>
    win.webContents
      .executeJavaScript('document.body?.dataset.ready === "true"')
      .then((ready: unknown) => ready === true)
      .catch(() => false)
  for (let i = 0; i < 300 && !win.isDestroyed(); i++) {
    if (await isReady()) return log.info('app', 'ui ready', { ffmpeg: await media.status() })
    await new Promise((done) => setTimeout(done, 200))
  }
}

/** ⌘Q, the menu or the Dock's "Quit" while an analysis or export runs */
async function askBeforeQuit(): Promise<void> {
  askingToQuit = true
  // a sheet on a shown window: a dialog without one is app-modal and would block the main process
  const win = [...windows].find((w) => !w.isDestroyed()) ?? createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  // the Dock's "Quit" does not bring the app to the front: the question must not hide behind
  app.focus({ steal: true })
  const { response } = await dialog
    .showMessageBox(win, {
      type: 'warning',
      message: 'Quit Glimpse?',
      detail: 'An export or an analysis is running. If you quit, it is cancelled.',
      buttons: ['Keep working', 'Quit'],
      defaultId: 0,
      cancelId: 0
    })
    .catch((err: unknown) => {
      // quit as asked rather than leave ⌘Q dead (askingToQuit would stay set)
      log.error('app', 'quit question failed', { err })
      return { response: 1 }
    })
  askingToQuit = false
  if (response !== 1) return
  quitConfirmed = true
  app.quit()
}

function fail(err: unknown): void {
  log.error('app', 'startup failed', { err })
  if (!E2E) {
    // the settings (and their log button) are out of reach: name the file
    dialog.showErrorBox(
      'Glimpse could not start',
      `An error occurred at startup. You can find details in the log file:\n${createAppPaths(app.getPath('userData')).logFile}`
    )
  }
  app.exit(1)
}

// Two instances on the same profile would overwrite each other's project files.
if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = [...windows].find((w) => !w.isDestroyed())
    if (!win) {
      if (core) createWindow()
      return
    }
    if (win.isMinimized()) win.restore()
    if (!E2E) win.show()
    win.focus()
  })

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })

  app.on('activate', () => {
    if (core && windows.size === 0) createWindow()
  })

  // macOS: closing the window keeps the app and its jobs running; the Dock icon opens it again.
  // E2E runs have no Dock icon to do that.
  app.on('window-all-closed', () => {
    if (E2E) app.quit()
  })

  app.on('before-quit', (event) => {
    if (!core) return
    const step = quitStep({
      ready: quitReady,
      confirmed: quitConfirmed,
      system: systemQuit,
      asking: askingToQuit,
      // E2E must never ask: its stubbed dialog answers "Keep working" and every close would hang
      e2e: E2E,
      unfinishedWork: core.jobs.hasUnfinishedWork()
    })
    if (step === 'quit') return
    event.preventDefault()
    if (step === 'ask') void askBeforeQuit()
    if (step !== 'shutdown') return
    void core
      .shutdown()
      .catch((err: unknown) => log.error('app', 'shutdown failed', { err }))
      .finally(() => {
        quitReady = true
        app.quit()
      })
  })

  app.whenReady().then(main).catch(fail)
}
