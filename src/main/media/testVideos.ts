// Synthetic test videos with distinct content for media integration tests, E2E and
// `npm run testvideos` (scripts/make-test-videos.mjs). Node runs this file directly via type
// stripping, so it must stay self-contained: Node builtins only, no path aliases, and only erasable
// TypeScript syntax (no enums, namespaces or parameter properties). It must also load as CommonJS
// (Playwright compiles the E2E specs that import it that way), so it cannot know its own location:
// every caller passes the cache folder (<repo>/.cache/test-videos, git-ignored).

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type TestVideoKey = 'portrait' | 'portraitHevc' | 'landscapeSilent' | 'rotated'

export interface TestVideo {
  key: TestVideoKey
  path: string
  fileName: string
  /** nominal duration; the container may report a few ms more (AAC padding) */
  durationSec: number
  /** display size (rotation applied) */
  width: number
  height: number
  /** clockwise display rotation from the container metadata */
  rotation: number
  fps: number
  videoCodec: 'h264' | 'hevc'
  hasAudio: boolean
  /** ISO time the container metadata says the clip was recorded, null when absent */
  recordedAt: string | null
}

export type TestVideoSet = Record<TestVideoKey, TestVideo>

/**
 * ffmpeg or ffprobe for tests and scripts: HC_FFMPEG / HC_FFPROBE, then the repo's own copy
 * (vendor/ffmpeg, fetched by scripts/fetch-ffmpeg.mjs), and Homebrew only while that is missing.
 */
export function devBinary(
  name: 'ffmpeg' | 'ffprobe',
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync
): string {
  const fromEnv = env[name === 'ffmpeg' ? 'HC_FFMPEG' : 'HC_FFPROBE']?.trim()
  if (fromEnv) return fromEnv
  const vendored = join(repoRoot, 'vendor/ffmpeg', name)
  return exists(vendored) ? vendored : join('/opt/homebrew/bin', name)
}

export interface EnsureTestVideosOptions {
  /** see devBinary */
  ffmpegPath: string
  /** regenerate even if a complete set exists */
  force?: boolean
  log?: (message: string) => void
}

/** bump when the specs below change so cached sets are regenerated */
const SET_VERSION = 1
const MANIFEST = 'manifest.json'
const STALE_LOCK_MS = 3 * 60_000
const LOCK_TIMEOUT_MS = 10 * 60_000

interface Spec {
  video: Omit<TestVideo, 'path'>
  /** ffmpeg argument lists to try in order (later ones are fallbacks); OUT is the output path */
  attempts: string[][]
  /** optional second pass on the result (IN → OUT), e.g. to add rotation metadata */
  remux?: string[][]
}

const OUT = '{out}'
const IN = '{in}'

function stereoTone(seconds: number, base: number): string {
  // two tones with a slow "beat", distinct per clip
  const left = `0.25*sin(2*PI*${base}*t)*(0.6+0.4*sin(2*PI*2*t))`
  const right = `0.25*sin(2*PI*${base * 1.5}*t)*(0.6+0.4*sin(2*PI*2*t))`
  return `aevalsrc=${left}|${right}:s=48000:d=${seconds}`
}

// prettier-ignore
const SPECS: Spec[] = [
  {
    video: {
      key: 'portrait', fileName: 'portrait-h264.mp4', durationSec: 20, width: 1440, height: 1920,
      rotation: 0, fps: 30, videoCodec: 'h264', hasAudio: true,
      recordedAt: '2026-07-12T19:14:05.000Z'
    },
    attempts: [
      [
        '-f', 'lavfi', '-i', 'testsrc2=s=1440x1920:r=30:d=20',
        '-f', 'lavfi', '-i', stereoTone(20, 440),
        '-map', '0:v', '-map', '1:a',
        // 3 s GOP with B-frames, like camera footage: seeks must decode from an earlier keyframe
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '90', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-metadata', 'creation_time=2026-07-12T19:14:05Z',
        '-movflags', '+faststart', OUT
      ]
    ]
  },
  {
    video: {
      key: 'portraitHevc', fileName: 'portrait-hevc.mov', durationSec: 14, width: 1440, height: 1920,
      rotation: 0, fps: 30, videoCodec: 'hevc', hasAudio: true,
      recordedAt: '2026-07-12T19:20:00.000Z'
    },
    attempts: ['hevc_videotoolbox', 'libx265'].map((encoder) => [
      '-f', 'lavfi', '-i', 'gradients=s=1440x1920:r=30:d=14:speed=0.03:n=4,format=yuv420p',
      // mono 44.1 kHz: exercises channel/sample-rate normalisation
      '-f', 'lavfi', '-i', 'sine=f=330:sample_rate=44100:d=14:beep_factor=3',
      '-map', '0:v', '-map', '1:a',
      ...(encoder === 'libx265'
        ? ['-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '26', '-x265-params', 'log-level=error']
        : ['-c:v', 'hevc_videotoolbox', '-b:v', '6M']),
      '-tag:v', 'hvc1',
      '-c:a', 'aac', '-b:a', '96k', '-ac', '1',
      // iPhone-style local capture time with offset (= 19:20:00 UTC)
      '-movflags', '+use_metadata_tags',
      '-metadata', 'com.apple.quicktime.creationdate=2026-07-12T21:20:00+0200',
      OUT
    ])
  },
  {
    video: {
      key: 'landscapeSilent', fileName: 'landscape-silent.mp4', durationSec: 12, width: 1920,
      height: 1080, rotation: 0, fps: 60, videoCodec: 'h264', hasAudio: false, recordedAt: null
    },
    attempts: [
      [
        '-f', 'lavfi', '-i', 'cellauto=s=1920x1080:rule=30:r=60:scroll=1,format=yuv420p',
        '-t', '12',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '120',
        '-an', '-movflags', '+faststart', OUT
      ]
    ]
  },
  {
    // stored as 1920×1080, displayed as 1080×1920 (like a phone held upright)
    video: {
      key: 'rotated', fileName: 'rotated.mp4', durationSec: 10, width: 1080, height: 1920,
      rotation: 90, fps: 30, videoCodec: 'h264', hasAudio: true,
      recordedAt: '2026-07-12T19:40:00.000Z'
    },
    attempts: [
      [
        '-f', 'lavfi', '-i', 'testsrc=s=1920x1080:r=30:d=10,format=yuv420p',
        '-f', 'lavfi', '-i', stereoTone(10, 523),
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '60',
        '-c:a', 'aac', '-b:a', '128k', OUT
      ]
    ],
    remux: [
      // display matrix rotation is counter-clockwise: -90 = rotate 90° clockwise for display
      ['-display_rotation:v:0', '-90', '-i', IN, '-c', 'copy',
        '-metadata', 'creation_time=2026-07-12T19:40:00Z', OUT],
      // ffmpeg < 6.1
      ['-i', IN, '-c', 'copy', '-metadata:s:v:0', 'rotate=90',
        '-metadata', 'creation_time=2026-07-12T19:40:00Z', OUT]
    ]
  }
]

function describeSet(dir: string): TestVideoSet {
  const entries = SPECS.map(({ video }) => [
    video.key,
    { ...video, path: join(dir, video.fileName) }
  ])
  return Object.fromEntries(entries) as TestVideoSet
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isFile() && info.size > 0,
    () => false
  )
}

async function isComplete(dir: string, set: TestVideoSet): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')) as { version?: number }
    if (manifest.version !== SET_VERSION) return false
  } catch {
    return false
  }
  const present = await Promise.all(Object.values(set).map((video) => exists(video.path)))
  return present.every(Boolean)
}

function runFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg failed (${code}): ${stderr.trim()}`))
    })
  })
}

async function runFirstWorking(
  ffmpeg: string,
  attempts: string[][],
  vars: Record<string, string>
): Promise<void> {
  let lastError: unknown
  for (const attempt of attempts) {
    try {
      await runFfmpeg(
        ffmpeg,
        attempt.map((arg) => vars[arg] ?? arg)
      )
      return
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}

async function generate(ffmpeg: string, dir: string, spec: Spec): Promise<void> {
  const { key, fileName } = spec.video
  const finalPath = join(dir, fileName)
  const ext = fileName.slice(fileName.lastIndexOf('.'))
  const first = join(dir, `.${key}.${process.pid}.a${ext}`)
  const second = join(dir, `.${key}.${process.pid}.b${ext}`)
  try {
    await runFirstWorking(ffmpeg, spec.attempts, { [OUT]: first })
    if (spec.remux) {
      await runFirstWorking(ffmpeg, spec.remux, { [IN]: first, [OUT]: second })
      await rename(second, finalPath)
    } else {
      await rename(first, finalPath)
    }
  } finally {
    await rm(first, { force: true })
    await rm(second, { force: true })
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Cross-process lock (parallel test workers share the cache directory). */
async function withLock<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const lockDir = join(dir, '.lock')
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      await mkdir(lockDir)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const age = await stat(lockDir).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0
      )
      if (age > STALE_LOCK_MS) {
        await rm(lockDir, { recursive: true, force: true })
      } else if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${lockDir}`, { cause: err })
      } else {
        await sleep(250)
      }
    }
  }
  try {
    return await task()
  } finally {
    await rm(lockDir, { recursive: true, force: true })
  }
}

/**
 * Creates the test videos in `dir` once and returns their descriptions; later calls (also from
 * other processes) reuse the cached set. Takes a few seconds on Apple Silicon.
 */
export async function ensureTestVideos(
  dir: string,
  options: EnsureTestVideosOptions
): Promise<TestVideoSet> {
  const set = describeSet(dir)
  await mkdir(dir, { recursive: true })
  if (!options.force && (await isComplete(dir, set))) return set
  return withLock(dir, async () => {
    if (!options.force && (await isComplete(dir, set))) return set
    const ffmpeg = options.ffmpegPath
    options.log?.(`Generating test videos in ${dir} …`)
    await rm(join(dir, MANIFEST), { force: true })
    await Promise.all(SPECS.map((spec) => generate(ffmpeg, dir, spec)))
    await writeFile(
      join(dir, MANIFEST),
      JSON.stringify({ version: SET_VERSION, videos: set }, null, 2)
    )
    return set
  })
}
