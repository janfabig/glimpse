#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS script */
// UI snapshots with the mock API (npm run ui:snap).
//
// 1. builds the renderer alone with scripts/ui-harness/vite.config.mjs → .cache/ui-build
// 2. starts scripts/ui-harness/main.mjs through Playwright's Electron driver (offscreen window)
// 3. captures every shot → artifacts/ui/<shot>.png (1440×900) and
//    artifacts/ui/<shot>@1100x720.png (minimum window size). A shot is a mock scenario, optionally
//    followed by a few clicks (e.g. to open a dialog).
//
// Usage: node scripts/ui-snap.mjs [shot …] [--no-build] [--size=1440x900] [--scale=2]
//        [--no-traffic-lights] [--theme=light] (light shots get the suffix @light)

import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import electronPath from 'electron'
import { _electron as electron } from '@playwright/test'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')
const harnessMain = resolve(root, 'scripts/ui-harness/main.mjs')
const viteConfig = resolve(root, 'scripts/ui-harness/vite.config.mjs')
const buildDir = resolve(root, '.cache/ui-build')
const outDir = resolve(root, 'artifacts/ui')

/** @typedef {{ name: string, scenario?: string, prepare?: (page: import('@playwright/test').Page) => Promise<void> }} Shot */

/** @type {Shot[]} */
const SHOTS = [
  { name: 'home' },
  { name: 'nokey' },
  { name: 'noffmpeg' },
  // the packaged app whose own ffmpeg is missing or does not start: "Glimpse is damaged"
  { name: 'ffmpegbroken' },
  // the stored API key can no longer be read: Settings and the start screen say so
  { name: 'keyunreadable' },
  // Google rejected the stored key (deleted in AI Studio): not "Connected"
  { name: 'keyrejected' },
  {
    name: 'keyunreadable-home',
    scenario: 'keyunreadable',
    prepare: async (page) => {
      await page.getByTestId('close-settings').click()
      await page.waitForSelector('[data-testid="onboarding"]')
    }
  },
  { name: 'videos' },
  // three previews failed: only the filmstrip (the proxy is there), original gone, conversion failed
  { name: 'previewfailed' },
  {
    // the Prompt step leaves videos without a preview out of the count and the estimate
    name: 'previewfailed-brief',
    scenario: 'previewfailed',
    prepare: async (page) => {
      await page.getByTestId('next-step').click()
      await page.waitForSelector('[data-screen="brief"]')
    }
  },
  {
    // a new project before any video: the drop zone with its hints
    name: 'videos-empty',
    scenario: 'home',
    prepare: async (page) => {
      await page.getByTestId('new-project').click()
      await page.waitForSelector('[data-screen="videos"]')
    }
  },
  {
    // files are being read in (the mock's import takes ~2 s)
    name: 'importing',
    scenario: 'home',
    prepare: async (page) => {
      await page.getByTestId('new-project').click()
      await page.waitForSelector('[data-screen="videos"]')
      await page.getByTestId('add-videos').click()
      await page.waitForSelector('[data-testid="video-importing"]')
    }
  },
  { name: 'brief' },
  { name: 'analyzing' },
  // the daily quota stopped the run: the reason, "Open Settings" and the retry for afterwards
  { name: 'analysisfailed' },
  { name: 'review' },
  {
    // "More suggestions": one list, best first
    name: 'suggestions',
    scenario: 'review',
    prepare: async (page) => {
      await page.getByTestId('tab-suggestions').click()
      await page.waitForSelector('[data-testid="suggestion-item"]')
    }
  },
  {
    // re-analysing a project with a reel asks first
    name: 'reanalyze',
    scenario: 'review',
    prepare: async (page) => {
      await page.getByTestId('step-brief').click()
      await page.waitForSelector('[data-screen="brief"]')
      await page.getByTestId('start-analysis').click()
      await page.waitForSelector('[data-testid="confirm-dialog"]')
    }
  },
  {
    // "Ask Gemini again": the dialog of the Edit step with a note typed in
    name: 'again',
    scenario: 'review',
    prepare: async (page) => {
      await page.getByTestId('again-open').click()
      await page.waitForSelector('[data-testid="again-dialog"]')
      await page
        .getByTestId('again-wish')
        .fill('More moments with my friends, less stage.\nInclude the sunset too.')
    }
  },
  { name: 'export' },
  { name: 'exporting' },
  { name: 'done' },
  { name: 'settings' },
  {
    // the lower part of the settings: privacy note and System with the log file
    name: 'settings-system',
    scenario: 'settings',
    prepare: async (page) => {
      await page.waitForSelector('[data-testid="settings-modal"]')
      await page.evaluate(() => {
        const body = document.querySelector('[data-testid="settings-modal"] .modal__body')
        if (body) body.scrollTop = body.scrollHeight
      })
    }
  }
]
const SHOT_NAMES = SHOTS.map((shot) => shot.name)
const SIZES = [
  { width: 1440, height: 900, suffix: '' },
  { width: 1100, height: 720, suffix: '@1100x720' }
]

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'no-build': { type: 'boolean', default: false },
    size: { type: 'string' },
    scale: { type: 'string', default: '1' },
    'no-traffic-lights': { type: 'boolean', default: false },
    theme: { type: 'string', default: 'dark' }
  }
})

if (!['dark', 'light'].includes(values.theme)) {
  console.error(`Unknown theme ${values.theme}. Known: dark, light`)
  process.exit(1)
}

const unknown = positionals.filter((name) => !SHOT_NAMES.includes(name))
if (unknown.length > 0) {
  console.error(`Unknown shot(s): ${unknown.join(', ')}. Known: ${SHOT_NAMES.join(', ')}`)
  process.exit(1)
}
const shots = positionals.length > 0 ? SHOTS.filter((s) => positionals.includes(s.name)) : SHOTS
const sizes = values.size
  ? SIZES.filter((size) => `${size.width}x${size.height}` === values.size)
  : SIZES
if (sizes.length === 0) {
  console.error(
    `Unknown size ${values.size}. Known: ${SIZES.map((s) => `${s.width}x${s.height}`).join(', ')}`
  )
  process.exit(1)
}

/** draws macOS traffic lights where hiddenInset puts them, to check the top bar's left inset */
function drawTrafficLights() {
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;pointer-events:none'
  for (const [index, color] of ['#ff5f57', '#febc2e', '#28c840'].entries()) {
    const dot = document.createElement('span')
    dot.style.cssText =
      `position:absolute;top:20px;left:${20 + index * 20}px;width:12px;height:12px;` +
      `border-radius:50%;background:${color};box-shadow:inset 0 0 0 0.5px rgba(0,0,0,.25)`
    overlay.append(dot)
  }
  document.body.append(overlay)
}

async function main() {
  if (!values['no-build']) {
    const started = Date.now()
    await build({ configFile: viteConfig })
    console.log(`Renderer built in ${((Date.now() - started) / 1000).toFixed(1)} s → ${buildDir}`)
  }
  await mkdir(outDir, { recursive: true })
  const indexUrl = pathToFileURL(resolve(buildDir, 'index.html'))
  let problems = 0

  for (const size of sizes) {
    const app = await electron.launch({
      executablePath: electronPath,
      args: [harnessMain],
      env: {
        ...process.env,
        UI_BUILD_DIR: buildDir,
        UI_WIDTH: String(size.width),
        UI_HEIGHT: String(size.height),
        UI_SCALE: values.scale,
        UI_SCENARIO: shots[0].scenario ?? shots[0].name
      }
    })
    try {
      const page = await app.firstWindow()
      await page.emulateMedia({ colorScheme: values.theme })
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') {
          problems++
          console.warn(`  [${message.type()}] ${message.text()}`)
        }
      })
      page.on('pageerror', (error) => {
        problems++
        console.warn(`  [pageerror] ${error.message}`)
      })
      for (const shot of shots) {
        const url = new URL(indexUrl)
        const scenario = shot.scenario ?? shot.name
        url.search = new URLSearchParams({ mock: '1', scenario, snap: '1' }).toString()
        await page.goto(url.href)
        await page.waitForSelector('body[data-ready="true"]', { timeout: 15_000 })
        await page.evaluate(() => document.fonts.ready.then(() => undefined))
        if (shot.prepare) await shot.prepare(page)
        // generated mock media and the first layout pass
        await page.waitForTimeout(350)
        if (!values['no-traffic-lights']) await page.evaluate(drawTrafficLights)
        const theme = values.theme === 'light' ? '@light' : ''
        const file = resolve(outDir, `${shot.name}${theme}${size.suffix}.png`)
        await page.screenshot({ path: file })
        console.log(`✓ ${shot.name} ${size.width}×${size.height} → ${file}`)
      }
    } finally {
      await app.close()
    }
  }
  if (problems > 0) console.warn(`${problems} console problem(s) – see above.`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
