// Per-clip intermediate: one ffmpeg run that cuts, frames (crop / blurred background), retimes,
// converts to SDR BT.709 and fades a clip. Every intermediate has exactly `frames` video frames
// and `samples` PCM samples (= the same duration) and identical colour tags, so clips can be
// joined without drift.

import type { FitMode } from '@shared/types'
import type { SdrConversion } from '../color'
import { BT709_FRAME_TAGS, sdrConversionFilters } from '../color'
import { formatSeconds, LOCAL_VIDEO_INPUT } from '../ffargs'
import type { Size } from '../geometry'
import { evenRound, sameAspect } from '../geometry'

export const AUDIO_RATE = 48_000
export const FADE_SEC = 0.5
/** extra input read beyond the clip so the frame-exact trim never runs short */
export const INPUT_MARGIN_SEC = 0.1
/**
 * Every clip is decoded from up to this long before its start; the lead is dropped again by the
 * frame- and sample-exact trims. An input seek can land on an open-GOP keyframe (HEVC CRA from
 * VideoToolbox with B-frames, x265) whose leading pictures cannot be decoded from there, so the
 * frames just before that keyframe would otherwise show a frozen copy of it.
 */
export const PRE_ROLL_SEC = 0.5
/**
 * A clip starting this close to the end of the video stream (at least two source frames) is
 * decoded from this far before the end, so there is a frame to hold even when only audio goes on.
 */
export const TAIL_HOLD_SEC = 0.5
/** the blurred background is rendered at 1/8 size (same look, a fraction of the cost) */
export const BLUR_DOWNSCALE = 8
/** blur strength (gblur sigma at full size) as a part of the frame's short side: 60 px at 4K */
export const BLUR_SIGMA_PART = 1 / 36

export interface ClipTiming {
  start: number
  frames: number
  /** frames / fps – the exact duration of the intermediate */
  durationSec: number
  samples: number
  /** input seek position: the pre-roll before `start` (more for clips at the end of the video) */
  seekSec: number
  /** frames / samples between `seekSec` and `start`, decoded and dropped again */
  leadFrames: number
  leadSamples: number
  /** input to read from `seekSec` */
  inputSec: number
}

/**
 * The latest input seek that still decodes a frame of the source: frame-accurate seeking drops
 * every frame before the seek point, and sources whose audio outlasts the video have no frame at
 * all near the end. null when the end of the video stream is unknown.
 */
export function latestFrameSeek(videoEndSec: number | null, sourceFps: number): number | null {
  if (videoEndSec === null) return null
  const twoFrames = sourceFps > 0 ? 2 / sourceFps : 0
  return Math.max(0, videoEndSec - Math.max(TAIL_HOLD_SEC, twoFrames))
}

/**
 * Quantises a clip to whole output frames; samples follow (integral for 24/25/30/50/60 fps).
 * Decoding starts PRE_ROLL_SEC before the clip (less near the file start); a clip starting after
 * `latestSeekSec` (see latestFrameSeek) is decoded from there instead, so its frames – or the held
 * last frame, like the preview player shows it – are still there. The lead is dropped again.
 */
export function clipTiming(
  start: number,
  end: number,
  fps: number,
  latestSeekSec: number | null = null
): ClipTiming {
  const frames = Math.max(1, Math.round((end - start) * fps))
  const durationSec = frames / fps
  const holdFrom = latestSeekSec ?? Infinity
  const tailLead = start > holdFrom ? Math.round((start - holdFrom) * fps) : 0
  const leadFrames = Math.min(
    Math.max(Math.round(PRE_ROLL_SEC * fps), tailLead),
    Math.floor(start * fps)
  )
  return {
    start,
    frames,
    durationSec,
    samples: Math.round((frames * AUDIO_RATE) / fps),
    seekSec: leadFrames > 0 ? Math.max(0, start - leadFrames / fps) : start,
    leadFrames,
    leadSamples: Math.round((leadFrames * AUDIO_RATE) / fps),
    inputSec: leadFrames / fps + durationSec + INPUT_MARGIN_SEC
  }
}

export interface ClipGraphOptions {
  target: Size
  /** display size of the source (rotation applied – ffmpeg autorotates before the graph) */
  source: Size
  fps: number
  fit: FitMode
  timing: ClipTiming
  hasAudio: boolean
  fadeIn: boolean
  fadeOut: boolean
  /** colour conversion of this source to SDR BT.709 */
  conversion: SdrConversion
}

/** fade length in frames: 0.5 s, at most half the clip */
export function fadeFrames(frames: number, fps: number): number {
  return Math.max(1, Math.min(Math.round(FADE_SEC * fps), Math.floor(frames / 2)))
}

function scaleTo(size: Size, mode: 'increase' | 'decrease'): string {
  const divisible = mode === 'decrease' ? ':force_divisible_by=2' : ''
  return (
    `scale=w=${size.width}:h=${size.height}:force_original_aspect_ratio=${mode}` +
    `${divisible}:out_range=tv`
  )
}

function videoChain(o: ClipGraphOptions): string {
  const { target, fps, timing } = o
  const nf = fadeFrames(timing.frames, fps)
  const lead = timing.leadFrames
  const convert = sdrConversionFilters(o.conversion)
  const finish = [
    'setsar=1',
    'format=yuv420p',
    BT709_FRAME_TAGS,
    ...(o.fadeIn ? [`fade=t=in:s=0:n=${nf}`] : []),
    ...(o.fadeOut ? [`fade=t=out:s=${timing.frames - nf}:n=${nf}`] : [])
  ].join(',')
  const decoded = [
    // start_time=0: when the video stream starts after the audio (or the seek lands between
    // frames), the first frame is repeated from t=0 instead of shifting the picture forward
    `[0:v:0]fps=fps=${fps}:start_time=0`,
    // pad with the last frame if the source ends early, then cut out the exact frames – before
    // the per-frame work, so the dropped lead and the input margin are never scaled or converted
    'tpad=stop_mode=clone:stop=-1',
    lead > 0
      ? `trim=start_frame=${lead}:end_frame=${lead + timing.frames}`
      : `trim=end_frame=${timing.frames}`,
    'setpts=PTS-STARTPTS'
  ].join(',')

  if (o.fit === 'crop' || sameAspect(o.source, target)) {
    const fill = [scaleTo(target, 'increase'), `crop=${target.width}:${target.height}`, ...convert]
    return `${decoded},${fill.join(',')},${finish}[v]`
  }
  const small: Size = {
    width: evenRound(target.width / BLUR_DOWNSCALE),
    height: evenRound(target.height / BLUR_DOWNSCALE)
  }
  const sigma = (Math.min(target.width, target.height) * BLUR_SIGMA_PART) / BLUR_DOWNSCALE
  // the conversion runs per branch: overlay works in 8 bits, HDR must be tone-mapped before it
  const background = [
    scaleTo(small, 'increase'),
    `crop=${small.width}:${small.height}`,
    ...convert,
    `gblur=sigma=${sigma}`,
    `scale=w=${target.width}:h=${target.height}`
  ]
  const foreground = [scaleTo(target, 'decrease'), ...convert]
  return [
    `${decoded},split=2[bgsrc][fgsrc]`,
    `[bgsrc]${background.join(',')}[bg]`,
    `[fgsrc]${foreground.join(',')}[fg]`,
    `[bg][fg]overlay=x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2,${finish}[v]`
  ].join(';')
}

function audioChain(o: ClipGraphOptions): string {
  const { samples, frames, leadSamples } = o.timing
  if (!o.hasAudio) {
    return `anullsrc=r=${AUDIO_RATE}:cl=stereo,atrim=end_sample=${samples}[a]`
  }
  const ns = Math.round((fadeFrames(frames, o.fps) * AUDIO_RATE) / o.fps)
  const lead = leadSamples > 0
  const filters = [
    // first_pts=0 pads/trims the start so audio stays in sync with the first video frame
    `aresample=${AUDIO_RATE}:async=1:first_pts=0`,
    'aformat=sample_fmts=fltp:channel_layouts=stereo',
    `apad=whole_len=${leadSamples + samples}`,
    lead
      ? `atrim=start_sample=${leadSamples}:end_sample=${leadSamples + samples}`
      : `atrim=end_sample=${samples}`,
    ...(lead ? ['asetpts=PTS-STARTPTS'] : []),
    ...(o.fadeIn ? [`afade=t=in:ss=0:ns=${ns}`] : []),
    ...(o.fadeOut ? [`afade=t=out:ss=${samples - ns}:ns=${ns}`] : [])
  ]
  return `[0:a:0]${filters.join(',')}[a]`
}

/** sound and container of every intermediate: PCM, so they join without loss or priming gaps */
// prettier-ignore
export const INTERMEDIATE_OUTPUT = [
  '-c:a', 'pcm_s16le', '-ar', String(AUDIO_RATE), '-ac', '2',
  '-map_metadata', '-1', '-map_chapters', '-1'
]

export function clipFilterGraph(o: ClipGraphOptions): string {
  return `${videoChain(o)};${audioChain(o)}`
}

export function clipArgs(p: {
  sourcePath: string
  timing: ClipTiming
  graph: string
  videoEncoderArgs: readonly string[]
  outPath: string
}): string[] {
  return [
    // input seeking is frame-accurate when transcoding
    '-ss',
    formatSeconds(p.timing.seekSec),
    '-t',
    formatSeconds(p.timing.inputSec),
    ...LOCAL_VIDEO_INPUT,
    '-i',
    p.sourcePath,
    '-filter_complex',
    p.graph,
    '-map',
    '[v]',
    '-map',
    '[a]',
    ...p.videoEncoderArgs,
    ...INTERMEDIATE_OUTPUT,
    p.outPath
  ]
}
