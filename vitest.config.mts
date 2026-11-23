import { existsSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// The repo's own ffmpeg (vendor/ffmpeg, scripts/fetch-ffmpeg.mjs) for every test that looks ffmpeg up
// the way the app does, so no test needs Homebrew's. An HC_FFMPEG / HC_FFPROBE of the caller wins.
const vendored = (name: string, key: string): Record<string, string> => {
  const path = resolve('vendor/ffmpeg', name)
  return process.env[key]?.trim() || !existsSync(path) ? {} : { [key]: path }
}

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', '{scripts,build}/*.test.mjs'],
    env: { ...vendored('ffmpeg', 'HC_FFMPEG'), ...vendored('ffprobe', 'HC_FFPROBE') },
    // ffmpeg-based integration tests render real (short) videos
    testTimeout: 120_000,
    hookTimeout: 180_000
  }
})
