// Generates the synthetic test videos used by the media tests and E2E
// (see src/main/media/testVideos.ts; Node runs the .ts file directly via type stripping).
//
//   npm run testvideos                 → <repo>/.cache/test-videos
//   npm run testvideos -- <dir>        → custom directory
//   npm run testvideos -- --force      → regenerate even if the set is complete

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// package.json has no "type" field, so Node warns that it re-parses the .ts file as ESM.
// That is expected here – silence just this warning while importing.
const emitWarning = process.emitWarning
process.emitWarning = function (warning, ...rest) {
  const code = typeof rest[0] === 'object' && rest[0] !== null ? rest[0].code : rest[1]
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON') return
  return emitWarning.call(this, warning, ...rest)
}
const { devBinary, ensureTestVideos } = await import('../src/main/media/testVideos.ts')
process.emitWarning = emitWarning

const args = process.argv.slice(2)
const force = args.includes('--force')
const dirArg = args.find((arg) => !arg.startsWith('--'))
// <repo>/.cache/test-videos (git-ignored), shared with the media tests and E2E
const dir = dirArg
  ? resolve(dirArg)
  : fileURLToPath(new URL('../.cache/test-videos', import.meta.url))

const started = Date.now()
const videos = await ensureTestVideos(dir, {
  // the repo's own ffmpeg (vendor/ffmpeg) first
  ffmpegPath: devBinary('ffmpeg', fileURLToPath(new URL('..', import.meta.url))),
  force,
  log: (message) => console.log(message)
})
for (const video of Object.values(videos)) {
  const details = [
    `${video.width}×${video.height}`,
    `${video.durationSec} s`,
    `${video.fps} fps`,
    video.videoCodec,
    video.hasAudio ? 'audio' : 'no audio',
    video.rotation ? `rotation ${video.rotation}°` : null
  ].filter(Boolean)
  console.log(`${video.key.padEnd(16)} ${details.join(', ').padEnd(56)} ${video.path}`)
}
console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s`)
