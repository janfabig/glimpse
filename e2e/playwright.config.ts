// End-to-end tests against the built app (out/main/index.js) with Playwright's Electron driver.
//
//   npm run test:e2e                      builds the app, then runs every flow
//   npx playwright test -c e2e/playwright.config.ts e2e/02-happy-path.spec.ts   one file, no build
//
// Every test starts the app with HC_E2E=1 (hidden window, no Dock icon, no Keychain), HC_FAKE_AI=1
// (deterministic fake Gemini, no network) and a fresh HC_USER_DATA_DIR / HC_OUTPUT_DIR that are
// removed afterwards. Optional environment:
//   HC_E2E_MAIN     main script of another build (default: the app folder → out/main/index.js)
//   HC_E2E_TMP_DIR  parent folder for the temp dirs (default: the OS temp folder)
//   HC_E2E_TRACE=0  no Playwright traces (default: one per launch, kept for failed tests only)
//   HC_FFPROBE      ffprobe used to verify the exports (default: vendor/ffmpeg/ffprobe)
//
// A failed test leaves full diagnostics in its folder under test-results/: main.log, the main
// process output, the renderer console, a screenshot and the traces (`npx playwright show-trace`).
// Playwright empties test-results/ when the next run starts – copy the folder first.

import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  outputDir: '../test-results',
  // one Electron app at a time: renders and proxies are CPU-heavy and timing-sensitive
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  // generous: test videos are prepared, analysed and rendered for real (ffmpeg)
  timeout: 6 * 60_000,
  expect: { timeout: 20_000 },
  use: {
    actionTimeout: 20_000
  }
})
