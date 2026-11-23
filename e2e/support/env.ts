// Paths and settings shared by the E2E support code.

import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { devBinary } from '../../src/main/media/testVideos'

export const REPO_ROOT = resolve(__dirname, '../..')

/**
 * What Electron starts: by default the app folder, i.e. package.json → "main": out/main/index.js
 * (`npm run test:e2e` builds it first) with the app's real name and version. HC_E2E_MAIN points at
 * the main script of another build instead.
 */
export const APP_ENTRY = process.env.HC_E2E_MAIN ?? REPO_ROOT

/** parent of every temp dir the suite creates */
export const TEMP_ROOT = process.env.HC_E2E_TMP_DIR ?? tmpdir()

// the repo's own ffmpeg (vendor/ffmpeg, like the app under test), not Homebrew's
export const FFPROBE = devBinary('ffprobe', REPO_ROOT)
export const FFMPEG = devBinary('ffmpeg', REPO_ROOT)

/** cache of src/main/media/testVideos.ts (git-ignored, shared with the media tests) */
export const TEST_VIDEO_DIR = join(REPO_ROOT, '.cache/test-videos')

/** a Playwright trace per launch, kept for failed tests only; HC_E2E_TRACE=0 turns it off */
export const TRACE = process.env.HC_E2E_TRACE !== '0'

/** timeouts for the real background work (generous: other processes may load the machine) */
export const TIMEOUTS = {
  launch: 60_000,
  prepare: 180_000,
  analysis: 180_000,
  export: 300_000
} as const
