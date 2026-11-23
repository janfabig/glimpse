// Flow 8 – security smoke: the renderer only sees window.api (no Node), cannot navigate away or
// open windows, external links go through the allow-list, hc-media: serves no foreign files and
// file: serves nothing but the renderer bundle. The app menu is English.

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { HighlightApi } from '../src/shared/ipc'
import { expect, test } from './fixtures'
import { REPO_ROOT } from './support/env'
import { createProject, screen } from './support/flows'
import { copyVideo } from './support/media'

interface MenuEntry {
  label: string
  role: string | null
  submenu: MenuEntry[] | null
}

function labelsOf(entries: MenuEntry[]): string[] {
  return entries.flatMap((entry) => [entry.label, ...labelsOf(entry.submenu ?? [])])
}

/** every member of HighlightApi – the compiler keeps this list in sync with src/shared/ipc.ts */
const API_MEMBERS = {
  getAppInfo: true,
  getSettings: true,
  updateSettings: true,
  testApiKey: true,
  listModels: true,
  listProjects: true,
  createProject: true,
  openProject: true,
  deleteProject: true,
  mutateProject: true,
  pickVideoFiles: true,
  addVideos: true,
  removeVideo: true,
  retryPrepare: true,
  getPathForFile: true,
  startAnalysis: true,
  analyzeAgain: true,
  cancelAnalysis: true,
  autoSelect: true,
  chooseOutputDir: true,
  startExport: true,
  cancelExport: true,
  showInFinder: true,
  openFile: true,
  openOriginal: true,
  openExternal: true,
  onProjectUpdated: true,
  onExportProgress: true,
  onToast: true
} satisfies Record<keyof HighlightApi, true>

test.describe('Flow 8: security smoke', () => {
  test('the renderer gets exactly window.api and no Node.js', async ({ hc }) => {
    const exposed = await hc.page.evaluate(() => {
      const api = (window as unknown as { api: Record<string, unknown> }).api
      return {
        keys: Object.keys(api).sort(),
        types: [...new Set(Object.values(api).map((value) => typeof value))],
        frozen: Object.isFrozen(api)
      }
    })
    expect(exposed.keys).toEqual(Object.keys(API_MEMBERS).sort())
    expect(exposed.types).toEqual(['function'])
    expect(exposed.frozen, 'the bridge cannot be tampered with').toBe(true)

    const globals = await hc.page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      return {
        require: typeof w.require,
        process: typeof w.process,
        module: typeof w.module,
        Buffer: typeof w.Buffer,
        global: typeof w.global,
        electron: typeof w.electron,
        ipcRenderer: typeof w.ipcRenderer
      }
    })
    expect(globals).toEqual({
      require: 'undefined',
      process: 'undefined',
      module: 'undefined',
      Buffer: 'undefined',
      global: 'undefined',
      electron: 'undefined',
      ipcRenderer: 'undefined'
    })

    // the Content Security Policy blocks inline scripts and string evaluation. (DevTools lets
    // code inside evaluate() call eval despite a CSP; a string timer runs later, outside of it.)
    hc.allowConsoleError(/violates the following Content Security Policy directive/)
    const csp = await hc.page.evaluate(async () => {
      const script = document.createElement('script')
      script.textContent = 'window.__hcInjected = true'
      document.body.append(script)
      const stringTimer = window.setTimeout as unknown as (code: string, ms: number) => number
      stringTimer('window.__hcEvaluated = true', 0)
      await new Promise((resolve) => setTimeout(resolve, 300))
      const w = window as unknown as { __hcInjected?: boolean; __hcEvaluated?: boolean }
      return { injected: w.__hcInjected ?? false, evaluated: w.__hcEvaluated ?? false }
    })
    expect(csp).toEqual({ injected: false, evaluated: false })
  })

  test('navigation away from the app and new windows are blocked', async ({ hc }) => {
    const { page } = hc
    const appUrl = page.url()
    expect(appUrl).toMatch(/^file:\/\/.*\/renderer\/index\.html$/)

    // window.open is denied – an allow-listed link goes to the (stubbed) browser instead
    const opened = await page.evaluate(() => [
      window.open('https://example.com/') === null,
      window.open('https://aistudio.google.com/apikey', '_blank') === null
    ])
    expect(opened).toEqual([true, true])
    await expect
      .poll(() => hc.shellCalls())
      .toEqual([{ method: 'openExternal', arg: 'https://aistudio.google.com/apikey' }])
    expect(hc.app.windows()).toHaveLength(1)
    expect(await hc.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(
      1
    )

    // the openExternal API applies the same allow-list
    const rejected = await page.evaluate(() =>
      (window as unknown as { api: { openExternal(url: string): Promise<void> } }).api
        .openExternal('https://example.com/')
        .then(
          () => 'opened',
          (error: Error) => error.message
        )
    )
    expect(rejected).toContain('This link cannot be opened.')
    expect(await hc.shellCalls()).toHaveLength(1)
    await expect(screen(page, 'home')).toBeVisible()

    // renderer-initiated navigations (remote page, other local file) are stopped in main.
    // Last step: Playwright keeps waiting for the cancelled navigation, so from here on the page is
    // only checked through evaluate().
    for (const target of ['https://example.com/', 'file:///etc/hosts']) {
      await page.evaluate((url) => {
        window.location.href = url
      }, target)
      await expect.poll(() => hc.mainLog()).toContain(`"url":"${target}"`)
    }
    expect(await hc.mainLog()).toContain('navigation blocked')
    const still = await page.evaluate(() => ({
      url: window.location.href,
      ready: document.body.dataset.ready,
      home: document.querySelector('[data-screen="home"]') !== null
    }))
    expect(still).toEqual({ url: appUrl, ready: 'true', home: true })
    // the UI still reacts
    await page.evaluate(() =>
      (document.querySelector('[data-testid="open-settings"]') as HTMLButtonElement).click()
    )
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelector('[data-testid="settings-modal"]') !== null)
      )
      .toBe(true)
    expect(hc.app.windows()).toHaveLength(1)
  })

  test('hc-media serves only project media and the videos of known projects', async ({ hc }) => {
    const foreign = `hc-media://local/${encodeURIComponent('/etc/hosts')}`
    const fromMain = await hc.app.evaluate(async ({ net }, url) => {
      const response = await net.fetch(url)
      return response.status
    }, foreign)
    expect(fromMain).toBe(403)

    // the renderer may embed hc-media: images, but gets nothing for foreign files
    hc.allowConsoleError(/403/)
    const loaded = await hc.page.evaluate(
      (url) =>
        new Promise<string>((resolve) => {
          const image = new Image()
          image.onload = () => resolve('loaded')
          image.onerror = () => resolve('blocked')
          image.src = url
        }),
      foreign
    )
    expect(loaded).toBe('blocked')
    expect(await hc.mainLog()).toContain('blocked request')
  })

  test('a folder the user did not hand over is never listed – a script naming one gets nothing', async ({
    hc,
    videos
  }) => {
    const folder = join(hc.videoDir, 'Private')
    await mkdir(folder)
    await copyVideo(videos.portrait.path, folder, 'IMG_4711.mp4')
    await copyVideo(videos.rotated.path, folder, 'Family party.mp4')
    const id = await createProject(hc)
    // what a script in the renderer could try: no dialog, no drop
    const result = await hc.api('addVideos', id, [folder])
    expect(result.added).toBe(0)
    expect(result.skipped).toEqual([{ path: folder, reason: 'Not a supported video file.' }])
    expect(result.project.videos).toEqual([])
    expect(await hc.openDialogCalls()).toBe(0)
    // picked in the dialog, the same folder is welcome (Flow 9)
  })

  test('file: serves the renderer bundle only – no other local file', async ({ hc }) => {
    const { page } = hc
    // fetch() and <img> of files outside the bundle get a 403 from main (logged in the console)
    hc.allowConsoleError(/status of 403/)
    const outside = {
      hosts: 'file:///etc/hosts',
      // the app folder itself, next to the bundle
      packageJson: pathToFileURL(join(REPO_ROOT, 'package.json')).href,
      icon: pathToFileURL(join(REPO_ROOT, 'build', 'icon.png')).href
    }
    const result = await page.evaluate(async ({ hosts, packageJson, icon }) => {
      const status = (url: string): Promise<number | string> =>
        fetch(url).then(
          (response) => response.status,
          (error: Error) => `failed: ${error.message}`
        )
      const image = (url: string): Promise<string> =>
        new Promise((resolve) => {
          const img = new Image()
          img.onload = () => resolve('loaded')
          img.onerror = () => resolve('blocked')
          img.src = url
        })
      return {
        hosts: await status(hosts),
        packageJson: await status(packageJson),
        icon: await image(icon),
        // the page itself is part of the bundle
        bundle: await status(window.location.href)
      }
    }, outside)
    expect(result).toEqual({ hosts: 403, packageJson: 403, icon: 'blocked', bundle: 200 })
    await expect.poll(() => hc.mainLog()).toContain('"url":"file:///etc/hosts"')
    expect(await hc.mainLog()).toContain('blocked request')
  })

  test('the app menu is English with our labels and keeps the native edit commands', async ({
    hc
  }) => {
    const menu = await hc.app.evaluate(({ Menu }) => {
      type Entry = { label: string; role: string | null; submenu: Entry[] | null }
      const describe = (items: Electron.MenuItem[]): Entry[] =>
        items
          .filter((item) => item.type !== 'separator')
          .map((item) => ({
            label: item.label,
            role: item.role ? String(item.role).toLowerCase() : null,
            submenu: item.submenu ? describe(item.submenu.items) : null
          }))
      return describe(Menu.getApplicationMenu()?.items ?? [])
    })
    expect(menu.map((entry) => entry.label)).toEqual(['Glimpse', 'Edit', 'View', 'Window'])
    // the Edit menu is what makes ⌘C/⌘V work in text fields
    const edit = menu[1].submenu ?? []
    expect(edit.map((entry) => [entry.role, entry.label])).toEqual([
      ['undo', 'Undo'],
      ['redo', 'Redo'],
      ['cut', 'Cut'],
      ['copy', 'Copy'],
      ['paste', 'Paste'],
      ['selectall', 'Select All']
    ])
    expect(labelsOf(menu[0].submenu ?? [])).toEqual([
      'About Glimpse',
      'Services',
      'Hide Glimpse',
      'Hide Others',
      'Show All',
      'Quit Glimpse'
    ])
    expect(labelsOf(menu[3].submenu ?? [])).toContain('Close Window')
    // the menu is ours, not Electron's default one: no File or Help menu, and the app's name in
    // the first menu (E2E runs unpackaged: "Reload" and the developer tools are there – the
    // packaged app has none, see core/menu.test.ts)
    expect(labelsOf(menu).filter((label) => /^(File|Help)$|Electron/.test(label))).toEqual([])
    expect(labelsOf(menu[2].submenu ?? [])).toEqual([
      'Reload',
      'Force Reload',
      'Toggle Developer Tools',
      'Toggle Full Screen'
    ])
  })

  test('is called Glimpse, also in the data folder and the Keychain entry', async ({ hc }) => {
    expect(await hc.page.title()).toBe('Glimpse')
    // Electron builds both from app.getName(): the data folder is appData + name, the Keychain
    // entry of the API key is name + ' Safe Storage'. Only the strings are read here.
    const names = await hc.app.evaluate(({ app }) => ({
      dataFolder: `${app.getPath('appData')}/${app.getName()}`,
      keychainEntry: `${app.getName()} Safe Storage`
    }))
    expect(names.dataFolder).toMatch(/\/Library\/Application Support\/Glimpse$/)
    expect(names.keychainEntry).toBe('Glimpse Safe Storage')
  })
})
