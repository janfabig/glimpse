// Joining the per-clip intermediates into the final file: concat demuxer + stream copy. Hard cuts
// join the intermediates themselves; crossfades first turn them into segments that already hold
// the fades (xfade/acrossfade over two clips at a time, final encode).

import { MediaError } from '../../contracts'
import { MESSAGES } from '../errors'
import { formatSeconds } from '../ffargs'
import { AUDIO_RATE, INPUT_MARGIN_SEC, INTERMEDIATE_OUTPUT } from './clip'

export const LOUDNORM = 'loudnorm=I=-14:TP=-1.5:LRA=11'
export const AUDIO_BITRATE = '192k'

/**
 * Quotes a path for an ffconcat `file` directive. Inside single quotes everything is literal, so
 * a quote is written as '\'' (close, escaped quote, reopen). Line breaks cannot be represented.
 */
export function escapeConcatPath(path: string): string {
  if (/[\r\n]/.test(path)) throw new MediaError('invalid', MESSAGES.invalidPath)
  return `'${path.replace(/'/g, "'\\''")}'`
}

export function concatList(paths: readonly string[]): string {
  return ['ffconcat version 1.0', ...paths.map((p) => `file ${escapeConcatPath(p)}`), ''].join('\n')
}

/**
 * loudnorm works at 192 kHz internally, so resample back afterwards. Its output timestamps can
 * jump (by the length of a short first clip, or a frame in a crossfade chain) although no sample
 * is missing; the joined audio is one gapless stream from 0, so restamp it from the sample count.
 */
function audioFinishFilters(normalize: boolean): string[] {
  return normalize ? [LOUDNORM, `aresample=${AUDIO_RATE}`, 'asetpts=N/SR/TB'] : []
}

const AUDIO_OUTPUT = ['-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-ar', String(AUDIO_RATE), '-ac', '2']
const CONTAINER_OUTPUT = ['-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart']

export function concatJoinArgs(p: {
  listPath: string
  normalize: boolean
  outPath: string
}): string[] {
  const audioFilters = audioFinishFilters(p.normalize)
  return [
    // regenerate DTS from PTS: x264 starts its B-frame DTS offset only from the third frame, so a
    // 1–2-frame intermediate would make the copied DTS jump or run backwards at the join
    '-fflags',
    '+igndts',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    p.listPath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-c:v',
    'copy',
    ...(audioFilters.length > 0 ? ['-af', audioFilters.join(',')] : []),
    ...AUDIO_OUTPUT,
    ...CONTAINER_OUTPUT,
    p.outPath
  ]
}

export interface CrossfadeSegment {
  /** index of the clip the segment shows */
  clip: number
  /** frames at the start of the clip that the fade before it has already shown */
  skipFrames: number
  /** length of the segment: the clip without those frames */
  frames: number
  /** frames at the end that fade into the first frames of the next clip; 0 for the last clip */
  fadeFrames: number
}

/**
 * A crossfaded reel as a row of segments that are rendered one by one and then joined like hard
 * cuts. Segment k is clip k from where the fade before it ended, and its last frames already fade
 * into the start of clip k+1 – so no ffmpeg run opens more than two clips, however long the reel.
 * A transition is the requested length but at most half of either neighbour, so consecutive fades
 * never overlap and every clip keeps frames of its own; total = Σ d − Σ T.
 */
export function crossfadeSegments(
  clipFrames: readonly number[],
  fps: number,
  crossfadeSec: number
): CrossfadeSegment[] {
  const wanted = Math.max(1, Math.round(crossfadeSec * fps))
  const segments: CrossfadeSegment[] = []
  let skipFrames = 0
  for (const [clip, own] of clipFrames.entries()) {
    const next = clipFrames[clip + 1]
    const fadeFrames =
      next === undefined ? 0 : Math.min(wanted, Math.floor(own / 2), Math.floor(next / 2))
    segments.push({ clip, skipFrames, frames: own - skipFrames, fadeFrames })
    skipFrames = fadeFrames
  }
  return segments
}

/**
 * One segment of a crossfaded reel (see crossfadeSegments), from the intermediates `clips`: cut
 * frame- and sample-exactly, so the segments join without a doubled or missing frame.
 */
export function crossfadeSegmentArgs(p: {
  clips: readonly string[]
  segment: CrossfadeSegment
  fps: number
  videoEncoderArgs: readonly string[]
  outPath: string
}): string[] {
  const { clip, skipFrames, frames, fadeFrames } = p.segment
  const samples = (count: number): number => Math.round((count * AUDIO_RATE) / p.fps)
  const fades = fadeFrames > 0
  const graph = [
    `[0:v]trim=start_frame=${skipFrames},setpts=PTS-STARTPTS${fades ? '[v0]' : '[v]'}`,
    `[0:a]atrim=start_sample=${samples(skipFrames)},asetpts=PTS-STARTPTS${fades ? '[a0]' : '[a]'}`,
    ...(fades
      ? [
          `[1:v]trim=end_frame=${fadeFrames}[v1]`,
          `[1:a]atrim=end_sample=${samples(fadeFrames)}[a1]`,
          `[v0][v1]xfade=transition=fade:duration=${formatSeconds(fadeFrames / p.fps)}` +
            `:offset=${formatSeconds((frames - fadeFrames) / p.fps)}[v]`,
          `[a0][a1]acrossfade=ns=${samples(fadeFrames)}[a]`
        ]
      : [])
  ].join(';')
  // One decoder thread per clip: frame threads hold twice the frames (about 0.2 GB more per open
  // clip at 4K) and the segment is no faster, the encoder sets the pace.
  const nextStart = formatSeconds(fadeFrames / p.fps + INPUT_MARGIN_SEC)
  return [
    '-threads',
    '1',
    '-i',
    p.clips[clip],
    ...(fades ? ['-threads', '1', '-t', nextStart, '-i', p.clips[clip + 1]] : []),
    '-filter_complex',
    graph,
    '-map',
    '[v]',
    '-map',
    '[a]',
    ...p.videoEncoderArgs,
    ...INTERMEDIATE_OUTPUT,
    p.outPath
  ]
}
