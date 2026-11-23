import type { ProbeResult, ProgressFn } from '../contracts'
import { MediaError } from '../contracts'
import type { SdrConversion } from './color'
import {
  BT709_ENCODER_TAGS,
  BT709_FRAME_TAGS,
  describeTransfer,
  sdrConversion,
  sdrConversionFilters
} from './color'
import { isEnvironmentFailure, MESSAGES, throwIfAborted } from './errors'
import { LOCAL_VIDEO_INPUT, videoRunTimeoutMs } from './ffargs'
import { removeQuietly, writeAtomically } from './fsutil'
import type { Size } from './geometry'
import { fitShortSide } from './geometry'
import type { QuarterTurn, SourceInfo } from './probe'
import { inspectSource } from './probe'
import { runFfmpeg } from './runner'
import type { Toolchain } from './toolchain'

export const PROXY_SHORT_SIDE = 720
export const PROXY_MAX_FPS = 30
export const PROXY_VT_BITRATE = '2500k'
/** frame rate of the copy Gemini gets: at least twice the rate it samples (ai/request.ts) */
export const ANALYSIS_FPS = 4

export interface ProxyAttempt {
  encoder: 'h264_videotoolbox' | 'libx264'
  /** decode with `-hwaccel videotoolbox` (frames are downloaded, so CPU filters and autorotation work) */
  hwDecode: boolean
  /**
   * keep the decoded frames on the GPU for `fps` and the downscale (scale_vt) and download only
   * the small frames; the rotation is applied explicitly afterwards (needs `ProxySource.gpu`)
   */
  gpuScale?: true
}

/** what the GPU path needs to know about a source it can handle */
export interface GpuFrames {
  /** pixel format of the downloaded VideoToolbox frames */
  format: 'nv12' | 'p010le'
  /** clockwise turn applied to the downloaded (small) frames */
  turn: QuarterTurn
}

export interface ProxySource extends Size {
  fps: number
  hasAudio: boolean
  /** how the frames get to SDR BT.709 */
  conversion: SdrConversion
  /** null: not for the GPU path (codec, pixel format, mirrored or odd rotation) */
  gpu: GpuFrames | null
}

/**
 * VideoToolbox first (fast, low CPU): with GPU scaling, then with downloaded full-size frames;
 * finally a pure software path that works everywhere.
 */
export function proxyAttempts(
  tc: Pick<Toolchain, 'hardwareEncoders' | 'hwDecode' | 'gpuScaling'>
): ProxyAttempt[] {
  const attempts: ProxyAttempt[] = []
  if (tc.hardwareEncoders.includes('h264_videotoolbox')) {
    if (tc.hwDecode && tc.gpuScaling) {
      attempts.push({ encoder: 'h264_videotoolbox', hwDecode: true, gpuScale: true })
    }
    attempts.push({ encoder: 'h264_videotoolbox', hwDecode: tc.hwDecode })
  }
  attempts.push({ encoder: 'libx264', hwDecode: false })
  return attempts
}

/** VideoToolbox decodes these to frames that scale_vt and hwdownload handle */
const GPU_CODECS = new Set(['h264', 'hevc'])
const GPU_FORMATS: Record<string, GpuFrames['format']> = {
  yuv420p: 'nv12',
  yuvj420p: 'nv12',
  nv12: 'nv12',
  yuv420p10le: 'p010le',
  p010le: 'p010le'
}

/** GPU-path parameters of a source, or null when only the classic paths can handle it */
export function gpuFramesOf(
  info: Pick<SourceInfo, 'pixFmt' | 'quarterTurn'> & { probe: Pick<ProbeResult, 'videoCodec'> }
): GpuFrames | null {
  const format = info.pixFmt === null ? undefined : GPU_FORMATS[info.pixFmt]
  if (!GPU_CODECS.has(info.probe.videoCodec) || !format || info.quarterTurn === null) return null
  return { format, turn: info.quarterTurn }
}

/**
 * Standard rates a measured average snaps to: VFR phone clips report averages like 29.81 or
 * 30.02 (with r_frame_rate = the 600 Hz timescale), dropped frames in low light included.
 */
const STANDARD_RATES: readonly [number, string][] = [
  [24000 / 1001, '24000/1001'],
  [24, '24'],
  [25, '25'],
  [30000 / 1001, '30000/1001'],
  [30, '30']
]
const SNAP_TOLERANCE = 0.02

/**
 * Constant output frame rate for the `fps` filter (always applied: phone clips are VFR), capped
 * at 30 fps, plus the matching 1-second GOP.
 */
export function proxyFrameRate(sourceFps: number): { rate: string; gop: number } {
  const known = Number.isFinite(sourceFps) && sourceFps > 0
  const capped = known ? Math.min(sourceFps, PROXY_MAX_FPS) : PROXY_MAX_FPS
  const distance = (rate: number): number => Math.abs(capped - rate) / rate
  const nearest = STANDARD_RATES.reduce((a, b) => (distance(b[0]) < distance(a[0]) ? b : a))
  const [value, rate] =
    distance(nearest[0]) <= SNAP_TOLERANCE
      ? nearest
      : [capped, String(Math.round(capped * 1000) / 1000)]
  return { rate, gop: Math.max(1, Math.round(value)) }
}

/** filters that turn a frame clockwise by `turn` (what ffmpeg's autorotation inserts) */
function turnFilters(turn: QuarterTurn): string[] {
  if (turn === 90) return ['transpose=clock']
  if (turn === 180) return ['hflip', 'vflip']
  if (turn === 270) return ['transpose=cclock']
  return []
}

/**
 * Frames stay on the GPU until they are proxy-sized: `fps` drops frames, scale_vt scales the
 * stored (unrotated) picture, then only the small frames are downloaded. Colour conversion,
 * range, pixel format and the rotation follow on the CPU at proxy size – the same filters as on
 * the classic path, so the pictures match.
 */
function gpuFilters(source: ProxySource, gpu: GpuFrames, rate: string): string[] {
  const size = fitShortSide(source, PROXY_SHORT_SIDE)
  const quarter = gpu.turn === 90 || gpu.turn === 270
  const stored = quarter ? { width: size.height, height: size.width } : size
  const convert = sdrConversionFilters(source.conversion)
  return [
    `fps=fps=${rate}:start_time=0`,
    `scale_vt=w=${stored.width}:h=${stored.height}`,
    'hwdownload',
    `format=${gpu.format}`,
    // every conversion ends in limited range; without one, full-range sources still need it
    ...(convert.length > 0 ? convert : ['scale=out_range=tv']),
    'format=yuv420p',
    ...turnFilters(gpu.turn),
    BT709_FRAME_TAGS
  ]
}

function decodeArgs(attempt: ProxyAttempt): string[] {
  if (attempt.gpuScale) {
    // the rotation is applied explicitly: no autorotation (it cannot handle GPU frames) and no
    // display matrix in the output (players would turn the upright proxy once more)
    // prettier-ignore
    return [
      '-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld',
      '-noautorotate', '-display_rotation:v:0', '0'
    ]
  }
  return attempt.hwDecode ? ['-hwaccel', 'videotoolbox'] : []
}

export function proxyArgs(
  input: string,
  output: string,
  source: ProxySource,
  attempt: ProxyAttempt
): string[] {
  const size = fitShortSide(source, PROXY_SHORT_SIDE)
  const { rate, gop } = proxyFrameRate(source.fps)
  if (attempt.gpuScale && !source.gpu) throw new Error('proxy: source not suited for GPU scaling')
  const filters =
    source.gpu && attempt.gpuScale
      ? gpuFilters(source, source.gpu, rate)
      : [
          // start_time=0: a video stream that starts after the audio is padded with its first
          // frame, so the proxy timeline starts at 0 like the `-ss` timeline of the original
          `fps=fps=${rate}:start_time=0`,
          `scale=${size.width}:${size.height}:out_range=tv`,
          ...sdrConversionFilters(source.conversion),
          'format=yuv420p',
          BT709_FRAME_TAGS
        ]
  const videoCodec =
    attempt.encoder === 'h264_videotoolbox'
      ? ['-c:v', 'h264_videotoolbox', '-b:v', PROXY_VT_BITRATE, '-profile:v', 'high']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-profile:v', 'high']
  return [
    ...decodeArgs(attempt),
    ...LOCAL_VIDEO_INPUT,
    '-i',
    input,
    '-map',
    '0:v:0',
    ...(source.hasAudio ? ['-map', '0:a:0?'] : []),
    // Gemini gets a copy of the proxy: drop container metadata such as GPS location
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-vf',
    filters.join(','),
    ...videoCodec,
    ...BT709_ENCODER_TAGS,
    '-g',
    String(gop),
    '-keyint_min',
    String(gop),
    ...(attempt.encoder === 'libx264' ? ['-sc_threshold', '0'] : []),
    // exact 1-second keyframes: cheap seeking in the player, keyframe-only sprite extraction
    '-force_key_frames',
    'expr:gte(t,n_forced*1)',
    ...(source.hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : []),
    '-movflags',
    '+faststart',
    output
  ]
}

const describe = (a: ProxyAttempt): string =>
  `${a.encoder}${a.gpuScale ? ' (GPU scaling)' : a.hwDecode ? ' (hardware decoding)' : ''}`

/** Creates the proxy and returns the attempt that succeeded. */
export async function makeProxy(
  tc: Toolchain,
  input: string,
  outPath: string,
  opts: { durationSec: number; onProgress?: ProgressFn; signal?: AbortSignal },
  candidates: ProxyAttempt[] = proxyAttempts(tc)
): Promise<ProxyAttempt> {
  throwIfAborted(opts.signal)
  const info = await inspectSource(tc.ffprobe, input, opts.signal)
  const { probe, color } = info
  const source: ProxySource = {
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    hasAudio: probe.hasAudio,
    conversion: sdrConversion(color, probe, tc.toneMapping),
    gpu: gpuFramesOf(info)
  }
  // the GPU path only for sources it can handle; the classic paths take everything
  const attempts = candidates.filter((attempt) => !attempt.gpuScale || source.gpu !== null)
  if (source.conversion.kind === 'untonemapped') {
    tc.log.warn(
      `proxy: ${describeTransfer(source.conversion.transfer)} source converted to SDR without ` +
        'tone mapping (ffmpeg lacks libswscale colour management)',
      input
    )
  }
  const durationSec = opts.durationSec > 0 ? opts.durationSec : probe.durationSec

  return writeAtomically(outPath, async (tempPath) => {
    for (const [index, attempt] of attempts.entries()) {
      try {
        await runFfmpeg(tc.ffmpeg, proxyArgs(input, tempPath, source, attempt), {
          errorMessage: MESSAGES.proxy,
          durationSec,
          onProgress: opts.onProgress,
          signal: opts.signal,
          timeoutMs: videoRunTimeoutMs(durationSec)
        })
        return attempt
      } catch (err) {
        const next = attempts[index + 1]
        // a full disk or a missing permission hits every attempt alike
        const retryable = err instanceof MediaError && err.code === 'ffmpeg'
        if (!next || !retryable || isEnvironmentFailure(err)) throw err
        tc.log.warn(
          `proxy: ${describe(attempt)} failed, retrying with ${describe(next)}`,
          err.details
        )
        await removeQuietly(tempPath)
      }
    }
    throw new MediaError('ffmpeg', MESSAGES.proxy)
  })
}

/** the lean copy of a proxy that Gemini gets: same 720p picture and timeline, 4 fps, mono */
export function analysisCopyArgs(input: string, output: string, hwDecode: boolean): string[] {
  // prettier-ignore
  return [
    ...(hwDecode ? ['-hwaccel', 'videotoolbox'] : []),
    ...LOCAL_VIDEO_INPUT, '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1',
    '-vf', `fps=fps=${ANALYSIS_FPS}:start_time=0`,
    // x264 (not VideoToolbox, which holds its bitrate): crf adapts to the content, the cap bounds
    // busy footage; the BT.709 tags come with the proxy's frames
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-profile:v', 'high',
    '-maxrate', '1000k', '-bufsize', '2000k',
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
    '-movflags', '+faststart',
    output
  ]
}

export async function makeAnalysisCopy(
  tc: Toolchain,
  input: string,
  outPath: string,
  opts: { signal?: AbortSignal }
): Promise<void> {
  throwIfAborted(opts.signal)
  await writeAtomically(outPath, (tempPath) =>
    runFfmpeg(tc.ffmpeg, analysisCopyArgs(input, tempPath, tc.hwDecode), {
      errorMessage: MESSAGES.analysisCopy,
      signal: opts.signal
    })
  )
}
