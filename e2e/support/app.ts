// One Glimpse instance per test: launch (hidden window, isolated profile, fake Gemini),
// main-process stubs for native dialogs and the shell, relaunch on the same profile, and cleanup
// that leaves no process or temp folder behind.

import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { HighlightApi } from '../../src/shared/ipc'
import { APP_ENTRY, REPO_ROOT, TEMP_ROOT, TIMEOUTS, TRACE } from './env'
import { isAlive, killMatching } from './processes'

/** environment the app must never inherit from the shell running the tests */
const BLOCKED_ENV = new Set([
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_RENDERER_URL',
  'NODE_OPTIONS'
])

export interface ShellCall {
  method: 'openPath' | 'showItemInFolder' | 'openExternal'
  arg: string
}

/** state of the main-process stubs (lives in the app as globalThis.__hcE2e) */
interface StubState {
  openPaths: string[]
  directory: string | null
  openDialogCalls: number
  /** `properties` of every open dialog, in call order */
  openDialogProperties: string[][]
  shellCalls: ShellCall[]
}

type Api = HighlightApi
type InvokeName = {
  [K in keyof Api]: Api[K] extends (...args: never[]) => Promise<unknown> ? K : never
}[keyof Api]

export class HcApp {
  /** temp folder of this test: profile, export folder, copied videos */
  readonly root: string
  readonly userDataDir: string
  readonly outputDir: string
  readonly videoDir: string

  private application: ElectronApplication | null = null
  private currentPage: Page | null = null
  private launchCount = 0
  private readonly output: string[] = []
  /** every console message and page error of the renderer (all launches), for diagnostics */
  private readonly consoleLog: string[] = []
  private readonly consoleProblems: string[] = []
  private readonly allowedConsole: RegExp[] = []
  /** traces of the launches so far (in the temp folder); attached when the test fails */
  private readonly traceFiles: string[] = []
  /** extra environment of every launch (HcApp.create) */
  private readonly extraEnv: Record<string, string>

  private constructor(root: string, extraEnv: Record<string, string>) {
    this.root = root
    this.extraEnv = extraEnv
    this.userDataDir = join(root, 'profile')
    this.outputDir = join(root, 'exports')
    this.videoDir = join(root, 'videos')
  }

  /**
   * creates the temp folders; launch() starts the app, dispose() removes everything again.
   * `env`: extra environment for every launch, e.g. HC_FAKE_AI_REQUIRE_KEY=1 (no key, no Gemini).
   */
  static async create(options: { env?: Record<string, string> } = {}): Promise<HcApp> {
    await mkdir(TEMP_ROOT, { recursive: true })
    const root = await mkdtemp(join(TEMP_ROOT, 'hc-e2e-'))
    const hc = new HcApp(root, options.env ?? {})
    await mkdir(hc.videoDir, { recursive: true })
    return hc
  }

  get app(): ElectronApplication {
    if (!this.application) throw new Error('the app is not running')
    return this.application
  }

  get page(): Page {
    if (!this.currentPage) throw new Error('the app is not running')
    return this.currentPage
  }

  get running(): boolean {
    return this.application !== null
  }

  /** (re)starts the app on this test's profile and waits until the UI has loaded its data */
  async launch(): Promise<void> {
    if (this.application) throw new Error('the app is already running')
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !BLOCKED_ENV.has(key)) env[key] = value
    }
    Object.assign(env, this.extraEnv, {
      HC_E2E: '1',
      HC_FAKE_AI: '1',
      HC_USER_DATA_DIR: this.userDataDir,
      HC_OUTPUT_DIR: this.outputDir
    })
    const launch = ++this.launchCount
    const app = await electron.launch({
      args: [APP_ENTRY],
      cwd: REPO_ROOT,
      env,
      timeout: TIMEOUTS.launch
    })
    this.application = app
    const child = app.process()
    const collect =
      (stream: string) =>
      (chunk: Buffer): void => {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (line.trim()) this.output.push(`[launch ${launch} ${stream}] ${line}`)
        }
      }
    child.stdout?.on('data', collect('out'))
    child.stderr?.on('data', collect('err'))
    await this.installStubs()

    const page = await app.firstWindow({ timeout: TIMEOUTS.launch })
    this.currentPage = page
    const logLine = (text: string): void => {
      this.consoleLog.push(`${new Date().toISOString()} [launch ${launch}] ${text}`)
    }
    page.on('console', (message) => {
      logLine(`${message.type()}: ${message.text()}`)
      if (message.type() === 'error') this.consoleProblems.push(`console: ${message.text()}`)
    })
    page.on('pageerror', (error) => {
      logLine(`pageerror: ${error.stack ?? error.message}`)
      this.consoleProblems.push(`pageerror: ${error.message}`)
    })
    if (TRACE) await app.context().tracing.start({ screenshots: true, snapshots: true })
    // toasts disappear after a few seconds – record every one (also after a reload)
    await app.context().addInitScript(recordToasts)
    await page.evaluate(recordToasts)
    await page.waitForSelector('body[data-ready="true"]', { timeout: TIMEOUTS.launch })
    // nothing may ever show up on the desktop
    const visible = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((win) => win.isVisible())
    )
    expect(visible, 'HC_E2E windows stay hidden').toBe(false)
  }

  /**
   * Native dialogs and the shell are replaced in the main process: the file pickers return what
   * the test set with pickVideos()/pickDirectory(), and "Play", "Show in Finder" and
   * external links are only recorded – nothing opens on the desktop. The video picker accepts
   * files and folders; a dialog for folders only is the output folder picker.
   */
  private async installStubs(): Promise<void> {
    await this.app.evaluate(({ dialog, shell }) => {
      const state = {
        openPaths: [] as string[],
        directory: null as string | null,
        openDialogCalls: 0,
        openDialogProperties: [] as string[][],
        shellCalls: [] as { method: string; arg: string }[]
      }
      ;(globalThis as unknown as { __hcE2e: typeof state }).__hcE2e = state
      const showOpenDialog = async (
        ...args: unknown[]
      ): Promise<{ canceled: boolean; filePaths: string[] }> => {
        state.openDialogCalls++
        const options = (args.length > 1 ? args[1] : args[0]) as { properties?: string[] }
        const properties = options?.properties ?? []
        state.openDialogProperties.push([...properties])
        const wantsDirectory =
          properties.includes('openDirectory') && !properties.includes('openFile')
        const filePaths = wantsDirectory
          ? state.directory
            ? [state.directory]
            : []
          : [...state.openPaths]
        return { canceled: filePaths.length === 0, filePaths }
      }
      dialog.showOpenDialog = showOpenDialog as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async () => ({
        response: 0,
        checkboxChecked: false
      })) as unknown as typeof dialog.showMessageBox
      dialog.showErrorBox = () => undefined
      shell.openPath = async (path: string) => {
        state.shellCalls.push({ method: 'openPath', arg: path })
        return ''
      }
      shell.showItemInFolder = (path: string) => {
        state.shellCalls.push({ method: 'showItemInFolder', arg: path })
      }
      shell.openExternal = async (url: string) => {
        state.shellCalls.push({ method: 'openExternal', arg: url })
      }
    })
  }

  private async stubState(): Promise<StubState> {
    return this.app.evaluate(
      () => (globalThis as unknown as { __hcE2e: StubState }).__hcE2e
    ) as Promise<StubState>
  }

  /** what the next "Add videos" dialog returns – files or folders ([] = cancelled) */
  async pickVideos(paths: string[]): Promise<void> {
    await this.app.evaluate((_electron, next) => {
      ;(globalThis as unknown as { __hcE2e: { openPaths: string[] } }).__hcE2e.openPaths = next
    }, paths)
  }

  /** what the next folder dialog returns (null = cancelled) */
  async pickDirectory(dir: string | null): Promise<void> {
    await this.app.evaluate((_electron, next) => {
      ;(globalThis as unknown as { __hcE2e: { directory: string | null } }).__hcE2e.directory = next
    }, dir)
  }

  /** every toast the renderer showed since the page was loaded */
  async toasts(): Promise<RecordedToast[]> {
    return this.page.evaluate(
      () => (window as unknown as { __hcToasts?: RecordedToast[] }).__hcToasts ?? []
    )
  }

  async shellCalls(): Promise<ShellCall[]> {
    return (await this.stubState()).shellCalls
  }

  async openDialogCalls(): Promise<number> {
    return (await this.stubState()).openDialogCalls
  }

  /** `properties` of every open dialog the app showed, in call order */
  async openDialogProperties(): Promise<string[][]> {
    return (await this.stubState()).openDialogProperties
  }

  /** calls window.api in the renderer (the same bridge the UI uses) */
  async api<K extends InvokeName>(
    method: K,
    ...args: Parameters<Api[K]>
  ): Promise<Awaited<ReturnType<Api[K]>>> {
    return this.page.evaluate(
      ([name, params]) => {
        const api = (window as unknown as { api: Record<string, (...a: unknown[]) => unknown> }).api
        return api[name](...params)
      },
      [method, args] as [string, unknown[]]
    ) as Promise<Awaited<ReturnType<Api[K]>>>
  }

  /** a console error the test provokes on purpose */
  allowConsoleError(pattern: RegExp): void {
    this.allowedConsole.push(pattern)
  }

  unexpectedConsoleProblems(): string[] {
    return this.consoleProblems.filter(
      (problem) => !this.allowedConsole.some((pattern) => pattern.test(problem))
    )
  }

  /** everything the main process printed (all launches) */
  mainOutput(): string {
    return this.output.join('\n')
  }

  async mainLog(): Promise<string> {
    return readFile(join(this.userDataDir, 'logs', 'main.log'), 'utf8').catch(() => '')
  }

  /**
   * quits the app the normal way (before-quit: jobs stop, project files are flushed). The trace of
   * this launch is kept for the test's diagnostics unless `keepTrace` is false (a test that passed).
   */
  async close(options: { keepTrace?: boolean } = {}): Promise<void> {
    const app = this.application
    if (!app) return
    const child = app.process()
    if (TRACE) await this.stopTrace(app, options.keepTrace ?? true)
    this.application = null
    this.currentPage = null
    const closed = app.close().then(
      () => true,
      () => false
    )
    const timedOut = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30_000))
    if (!(await Promise.race([closed, timedOut])) && child.pid && isAlive(child.pid)) {
      child.kill('SIGKILL')
    }
  }

  /**
   * kills the main process without any shutdown – like a crash or a force quit. The trace of this
   * launch is lost: saving it first would delay the kill by ~200 ms, and the work would go on.
   */
  async crash(): Promise<void> {
    const app = this.application
    if (!app) return
    this.application = null
    this.currentPage = null
    const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()))
    app.process().kill('SIGKILL')
    await exited
    // helpers and ffmpeg children of the killed process
    killMatching(this.root)
  }

  /** ends the trace of the current launch: saved to the temp folder, or dropped (~2 ms vs ~200 ms) */
  private async stopTrace(app: ElectronApplication, keep: boolean): Promise<void> {
    const path = keep ? join(this.root, `trace-${this.launchCount}.zip`) : undefined
    await app
      .context()
      .tracing.stop(path ? { path } : {})
      .then(() => {
        if (path) this.traceFiles.push(path)
      })
      .catch(() => undefined)
  }

  /**
   * test teardown: diagnostics for failed tests, then nothing may be left behind. A failed test
   * leaves full files in its output folder (test-results/<test>/): main.log, the main process output,
   * the renderer console, a screenshot and a trace per launch (none for one ended by crash()). Text
   * attachments ("body") would reach the list reporter only as their first 300 characters and are
   * not saved anywhere.
   */
  async dispose(testInfo: TestInfo, forceDiagnostics = false): Promise<void> {
    const failed = forceDiagnostics || testInfo.status !== testInfo.expectedStatus
    if (failed && this.currentPage) {
      const shot = await this.currentPage.screenshot({ timeout: 5_000 }).catch(() => null)
      if (shot) await attachFile(testInfo, 'screenshot.png', shot, 'image/png')
    }
    await this.close({ keepTrace: failed })
    if (failed) {
      await attachFile(testInfo, 'main.log', await this.mainLog(), 'text/plain')
      await attachFile(testInfo, 'main-process-output.txt', this.mainOutput(), 'text/plain')
      await attachFile(testInfo, 'renderer-console.txt', this.consoleLog.join('\n'), 'text/plain')
      for (const trace of this.traceFiles) {
        // copied into the output folder before the temp folder goes
        await testInfo.attach('trace', { path: trace, contentType: 'application/zip' })
      }
    }
    // stray ffmpeg/Electron processes of this test (their command lines contain the temp folder)
    const stray = killMatching(this.root)
    if (stray.length > 0) {
      console.warn(`[e2e] killed ${stray.length} leftover process(es) of ${testInfo.title}`)
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(this.root, { recursive: true, force: true })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
  }
}

/** writes a diagnostics file into the test's output folder and attaches it (reporters show the path) */
async function attachFile(
  testInfo: TestInfo,
  name: string,
  body: string | Buffer,
  contentType: string
): Promise<void> {
  const path = testInfo.outputPath(name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body)
  await testInfo.attach(name, { path, contentType })
}

export interface RecordedToast {
  level: string
  text: string
}

/** runs in the renderer: collects every toast element that appears in window.__hcToasts */
function recordToasts(): void {
  const w = window as unknown as { __hcToasts?: { level: string; text: string }[] }
  if (w.__hcToasts) return
  const seen: { level: string; text: string }[] = []
  w.__hcToasts = seen
  const collect = (node: Node): void => {
    if (!(node instanceof HTMLElement)) return
    const toasts = node.matches('[data-testid="toast"]')
      ? [node]
      : [...node.querySelectorAll<HTMLElement>('[data-testid="toast"]')]
    for (const toast of toasts) {
      seen.push({ level: toast.dataset.level ?? '', text: toast.textContent ?? '' })
    }
  }
  // `document`, not documentElement: init scripts run before <html> exists
  new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach(collect)
  }).observe(document, { childList: true, subtree: true })
}

/** random dummy key that does not look like a Google key – only the app's own redaction can hide it */
export function dummyApiKey(): string {
  return `hc-e2e-key-${randomBytes(12).toString('hex')}`
}
