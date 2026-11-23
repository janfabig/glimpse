// Locating ffmpeg/ffprobe and detecting what they can do (once, cached).
// The packaged app uses only the copy it carries (Contents/Resources/ffmpeg). Development, tests and
// E2E prefer the repo's copy (vendor/ffmpeg); GUI apps started from Finder do not inherit the shell
// PATH, so the Homebrew locations are probed explicitly before asking a login shell.

import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { FfmpegStatus } from '@shared/types'
import { MediaError } from '../contracts'
import { sdrConversionFilters } from './color'
import { MESSAGES } from './errors'
import { runProcess } from './runner'

export interface MediaLogger {
  warn(message: string, details?: string): void
}

export interface Toolchain {
  ffmpeg: string
  ffprobe: string
  version: string | null
  /** encoder names compiled into ffmpeg */
  encoders: ReadonlySet<string>
  /** VideoToolbox encoders that passed a smoke test (empty when hardware acceleration is off) */
  hardwareEncoders: readonly string[]
  /** `-hwaccel videotoolbox` decoding is available (and hardware acceleration is on) */
  hwDecode: boolean
  /**
   * VideoToolbox frames can be scaled on the GPU (`scale_vt`) and downloaded afterwards
   * (smoke-tested; false when hardware decoding is unavailable or off)
   */
  gpuScaling: boolean
  /** the `scale` filter can tone-map HDR (HLG/PQ) to SDR (libswscale colour management) */
  toneMapping: boolean
  log: MediaLogger
}

export interface ToolchainOptions {
  ffmpegPath?: string
  ffprobePath?: string
  hardwareAcceleration?: boolean
  logger?: MediaLogger
  env?: NodeJS.ProcessEnv
  /**
   * The packaged app: the folder with its own ffmpeg and ffprobe. Nothing else is used then – no
   * option, no environment variable, no Homebrew folder, no login shell: those are places other
   * programs can write to.
   */
  bundledDir?: string
  /** development: the repo's vendor/ffmpeg (scripts/fetch-ffmpeg.mjs), tried before Homebrew */
  vendorDir?: string
}

/** Where the app looks for ffmpeg: packaged only inside itself, otherwise in the repo first. */
export function appFfmpegDirs(app: {
  isPackaged: boolean
  /** process.resourcesPath */
  resourcesPath: string
  /** app.getAppPath(): the repo when the app is not packaged */
  appPath: string
}): Pick<ToolchainOptions, 'bundledDir' | 'vendorDir'> {
  return app.isPackaged
    ? { bundledDir: join(app.resourcesPath, 'ffmpeg') }
    : { vendorDir: join(app.appPath, 'vendor/ffmpeg') }
}

const SEARCH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'] as const
const HARDWARE_ENCODERS = ['h264_videotoolbox'] as const

export interface ResolveDeps {
  isExecutable(path: string): Promise<boolean>
  /** PATH lookup through the user's login shell; returns name → absolute path */
  loginShellLookup(names: readonly string[]): Promise<Record<string, string | undefined>>
}

export interface ResolvedBinaries {
  ffmpeg: string | null
  ffprobe: string | null
}

/**
 * With `bundledDir` (the packaged app): only the two binaries in that folder. Otherwise, per binary:
 * explicit option → HC_FFMPEG/HC_FFPROBE → (ffprobe only: next to the resolved ffmpeg) → `vendorDir`
 * → /opt/homebrew/bin → /usr/local/bin → login-shell PATH. An explicitly configured path is
 * authoritative: when it is not executable the binary counts as missing.
 */
export async function resolveBinaries(
  options: Pick<ToolchainOptions, 'ffmpegPath' | 'ffprobePath' | 'bundledDir' | 'vendorDir'>,
  env: NodeJS.ProcessEnv,
  deps: ResolveDeps
): Promise<ResolvedBinaries> {
  const { bundledDir, vendorDir } = options
  if (bundledDir) {
    const own = async (name: string): Promise<string | null> =>
      (await deps.isExecutable(join(bundledDir, name))) ? join(bundledDir, name) : null
    return { ffmpeg: await own('ffmpeg'), ffprobe: await own('ffprobe') }
  }

  let shellResult: Promise<Record<string, string | undefined>> | null = null
  const shellLookup = (): Promise<Record<string, string | undefined>> =>
    (shellResult ??= deps.loginShellLookup(['ffmpeg', 'ffprobe']).catch(() => ({})))

  const resolveOne = async (
    name: 'ffmpeg' | 'ffprobe',
    pinned: string | undefined,
    extraCandidates: string[]
  ): Promise<string | null> => {
    if (pinned) return (await deps.isExecutable(pinned)) ? pinned : null
    const dirs = vendorDir ? [vendorDir, ...SEARCH_DIRS] : SEARCH_DIRS
    const candidates = [...extraCandidates, ...dirs.map((dir) => join(dir, name))]
    for (const candidate of candidates) {
      if (await deps.isExecutable(candidate)) return candidate
    }
    const fromShell = (await shellLookup())[name]
    return fromShell && (await deps.isExecutable(fromShell)) ? fromShell : null
  }

  const ffmpeg = await resolveOne(
    'ffmpeg',
    nonEmpty(options.ffmpegPath) ?? nonEmpty(env.HC_FFMPEG),
    []
  )
  const ffprobe = await resolveOne(
    'ffprobe',
    nonEmpty(options.ffprobePath) ?? nonEmpty(env.HC_FFPROBE),
    ffmpeg ? [join(dirname(ffmpeg), 'ffprobe')] : []
  )
  return { ffmpeg, ffprobe }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

async function isExecutableFile(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false
  try {
    await access(path, constants.X_OK)
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function loginShellLookup(
  names: readonly string[]
): Promise<Record<string, string | undefined>> {
  const shell = process.env.SHELL && isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
  const script = names.map((name) => `command -v ${name}`).join('; ')
  const result = await runProcess(shell, ['-l', '-c', script], {
    captureStdout: true,
    timeoutMs: 5000
  })
  return parseShellLookup(result.stdout, names)
}

/** Picks `/…/<name>` lines out of (possibly noisy) login-shell output. */
export function parseShellLookup(
  output: string,
  names: readonly string[]
): Record<string, string | undefined> {
  const found: Record<string, string | undefined> = {}
  for (const line of output.split(/\r?\n/).map((l) => l.trim())) {
    if (!line.startsWith('/')) continue
    const name = names.find((n) => line.endsWith(`/${n}`))
    if (name && !found[name]) found[name] = line
  }
  return found
}

/** "ffmpeg version 9.0.2 Copyright …" → "9.0.2" */
export function parseFfmpegVersion(output: string): string | null {
  // without a builder's address at the end ("9.0.2-https://www.martin-riedl.de")
  return /\bversion\s+(\S+)/.exec(output)?.[1].replace(/-https?:\/\/\S*$/, '') ?? null
}

/** Encoder names from `ffmpeg -encoders` (the table after the "------" separator). */
export function parseEncoderNames(output: string): Set<string> {
  const lines = output.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === '------')
  const names = new Set<string>()
  for (const line of lines.slice(start + 1)) {
    const match = /^\s*[VASDT][A-Z.]{5}\s+(\S+)/.exec(line)
    if (match) names.add(match[1])
  }
  return names
}

/** Method names from `ffmpeg -hwaccels`. */
export function parseHwaccelNames(output: string): Set<string> {
  const lines = output.split(/\r?\n/)
  const start = lines.findIndex((line) => /hardware acceleration methods/i.test(line))
  return new Set(
    lines
      .slice(start + 1)
      .map((line) => line.trim())
      .filter((line) => /^[\w-]+$/.test(line))
  )
}

/** true when ffmpeg runs `args` (plus quiet defaults) successfully */
async function smokeTest(ffmpeg: string, args: readonly string[]): Promise<boolean> {
  try {
    const result = await runProcess(
      ffmpeg,
      ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args, '-f', 'null', '-'],
      { timeoutMs: 15_000 }
    )
    return result.code === 0
  } catch {
    return false
  }
}

/** Encodes a few black frames; listing an encoder does not guarantee the hardware is usable. */
function smokeTestEncoder(ffmpeg: string, encoder: string): Promise<boolean> {
  // prettier-ignore
  return smokeTest(ffmpeg, [
    '-f', 'lavfi', '-i', 'color=c=black:s=640x480:r=30',
    '-frames:v', '5', '-pix_fmt', 'yuv420p', '-c:v', encoder
  ])
}

/** Tone-maps two 10-bit HLG frames with exactly the filter proxies and clips use. */
function smokeTestToneMapping(ffmpeg: string): Promise<boolean> {
  const [toneMap] = sdrConversionFilters({
    kind: 'tonemap',
    transfer: 'arib-std-b67',
    primaries: 'bt2020',
    matrix: 'bt2020'
  })
  const hlg =
    'color=c=gray:s=64x64:r=30,format=yuv420p10le,' +
    'setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=arib-std-b67:range=tv'
  // prettier-ignore
  return smokeTest(ffmpeg, [
    '-f', 'lavfi', '-i', hlg, '-vf', `${toneMap},format=yuv420p`, '-frames:v', '2'
  ])
}

/**
 * Uploads two frames, scales them with scale_vt and downloads them again (8 and 10 bit), with the
 * input options the GPU proxy path uses to apply the rotation itself (see proxy.ts).
 */
function smokeTestGpuScaling(ffmpeg: string): Promise<boolean> {
  const device = ['-init_hw_device', 'videotoolbox=vt', '-filter_hw_device', 'vt']
  const noRotation = ['-noautorotate', '-display_rotation:v:0', '0']
  const chain = (format: string): string =>
    `format=${format},hwupload,scale_vt=w=32:h=32,hwdownload,format=${format}`
  return Promise.all(
    ['nv12', 'p010le'].map((format) =>
      // prettier-ignore
      smokeTest(ffmpeg, [
        ...device, ...noRotation, '-f', 'lavfi', '-i', 'color=c=gray:s=64x64:r=30',
        '-vf', chain(format), '-frames:v', '2'
      ])
    )
  ).then((results) => results.every(Boolean))
}

const defaultLogger: MediaLogger = {
  warn: (message, details) => console.warn(`[media] ${message}`, details ?? '')
}

interface LoadResult {
  status: FfmpegStatus
  toolchain: Toolchain | null
}

export interface ToolchainLoader {
  status(): Promise<FfmpegStatus>
  /** the detected toolchain; throws MediaError('no-ffmpeg') when ffmpeg is unusable */
  ready(): Promise<Toolchain>
}

export function createToolchainLoader(
  options: ToolchainOptions = {},
  deps: ResolveDeps = { isExecutable: isExecutableFile, loginShellLookup }
): ToolchainLoader {
  const log = options.logger ?? defaultLogger
  const hardware = options.hardwareAcceleration !== false
  let cached: Promise<LoadResult> | null = null

  const unavailable = (paths: ResolvedBinaries, error: string): LoadResult => ({
    status: {
      ok: false,
      ffmpegPath: paths.ffmpeg,
      ffprobePath: paths.ffprobe,
      version: null,
      hardwareEncoders: [],
      error
    },
    toolchain: null
  })

  const load = async (): Promise<LoadResult> => {
    const paths = await resolveBinaries(options, options.env ?? process.env, deps)
    // the app's own copy is gone or does not start: no command can fix that, the app is damaged
    const damaged = options.bundledDir ? MESSAGES.damagedApp : null
    if (!paths.ffmpeg || !paths.ffprobe) return unavailable(paths, damaged ?? MESSAGES.noFfmpeg)
    const { ffmpeg, ffprobe } = paths

    const query = (bin: string, args: string[]): Promise<string | null> =>
      runProcess(bin, ['-hide_banner', ...args], { captureStdout: true, timeoutMs: 15_000 })
        .then((r) => (r.code === 0 ? r.stdout : null))
        .catch(() => null)
    const [versionOut, probeVersionOut, encodersOut, hwaccelsOut] = await Promise.all([
      query(ffmpeg, ['-version']),
      query(ffprobe, ['-version']),
      query(ffmpeg, ['-encoders']),
      query(ffmpeg, ['-hwaccels'])
    ])
    if (versionOut === null || probeVersionOut === null || encodersOut === null) {
      return unavailable(paths, damaged ?? MESSAGES.brokenFfmpeg)
    }

    const encoders = parseEncoderNames(encodersOut)
    const candidates = hardware ? HARDWARE_ENCODERS.filter((name) => encoders.has(name)) : []
    const hwDecode = hardware && parseHwaccelNames(hwaccelsOut ?? '').has('videotoolbox')
    const [toneMapping, gpuScaling, ...working] = await Promise.all([
      smokeTestToneMapping(ffmpeg),
      hwDecode ? smokeTestGpuScaling(ffmpeg) : Promise.resolve(false),
      ...candidates.map((name) => smokeTestEncoder(ffmpeg, name))
    ])
    const hardwareEncoders = candidates.filter((_, i) => working[i])
    const version = parseFfmpegVersion(versionOut)

    return {
      status: { ok: true, ffmpegPath: ffmpeg, ffprobePath: ffprobe, version, hardwareEncoders },
      toolchain: {
        ffmpeg,
        ffprobe,
        version,
        encoders,
        hardwareEncoders,
        hwDecode,
        gpuScaling,
        toneMapping,
        log
      }
    }
  }

  // Successful detection is cached for the app's lifetime; failures are retried on the next call
  // (e.g. after `node scripts/fetch-ffmpeg.mjs` in development).
  const get = (): Promise<LoadResult> => {
    if (!cached) {
      const pending = load()
      cached = pending
      pending.then(
        (result) => {
          if (!result.toolchain && cached === pending) cached = null
        },
        () => {
          if (cached === pending) cached = null
        }
      )
    }
    return cached
  }

  return {
    status: async () => (await get()).status,
    ready: async () => {
      const result = await get()
      if (!result.toolchain) {
        throw new MediaError('no-ffmpeg', result.status.error ?? MESSAGES.noFfmpeg)
      }
      return result.toolchain
    }
  }
}
