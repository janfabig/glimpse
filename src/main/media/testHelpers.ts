// Helpers for the media integration tests: inspect real output files with ffprobe/ffmpeg.
import { execFile } from 'node:child_process'
import { open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { devBinary } from './testVideos'

const exec = promisify(execFile)

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
// the repo's own ffmpeg (vendor/ffmpeg), not Homebrew's
export const FFMPEG = devBinary('ffmpeg', REPO_ROOT)
export const FFPROBE = devBinary('ffprobe', REPO_ROOT)

/** cache of the generated test videos (testVideos.ts): <repo>/.cache/test-videos, git-ignored */
export const TEST_VIDEO_DIR = fileURLToPath(new URL('../../../.cache/test-videos', import.meta.url))

export interface ProbedStream {
  codec_type: string
  codec_name: string
  codec_tag_string?: string
  width?: number
  height?: number
  pix_fmt?: string
  r_frame_rate?: string
  avg_frame_rate?: string
  sample_rate?: string
  channels?: number
  start_time?: string
  duration?: string
  nb_frames?: string
  nb_read_packets?: string
  color_range?: string
  color_space?: string
  color_transfer?: string
  color_primaries?: string
  side_data_list?: { rotation?: number }[]
  tags?: Record<string, string>
}

export interface Probed {
  format: { duration: string; format_name: string; tags?: Record<string, string> }
  streams: ProbedStream[]
  video: ProbedStream
  audio: ProbedStream | undefined
  durationSec: number
}

export async function ffprobe(
  path: string,
  options: { countPackets?: boolean } = {}
): Promise<Probed> {
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams']
  if (options.countPackets) args.push('-count_packets')
  const { stdout } = await exec(FFPROBE, [...args, path], { maxBuffer: 16 * 1024 * 1024 })
  const raw = JSON.parse(stdout) as Pick<Probed, 'format' | 'streams'>
  const video = raw.streams.find((s) => s.codec_type === 'video')
  if (!video) throw new Error(`no video stream in ${path}`)
  return {
    ...raw,
    video,
    audio: raw.streams.find((s) => s.codec_type === 'audio'),
    durationSec: Number(raw.format.duration)
  }
}

/** presentation times of all keyframes of the first video stream */
export async function keyframeTimes(path: string): Promise<number[]> {
  // prettier-ignore
  const { stdout } = await exec(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
    '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', path
  ])
  return stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/,$/, '').trim())
    .filter((line) => line.length > 0)
    .map(Number)
}

/** presentation times of all frames of the first video stream */
export async function frameTimes(path: string): Promise<number[]> {
  // prettier-ignore
  const { stdout } = await exec(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', path
  ], { maxBuffer: 16 * 1024 * 1024 })
  return stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/,$/, '').trim())
    .filter((line) => line.length > 0)
    .map(Number)
}

/** distinct colour tags of all decoded frames, e.g. ['bt709/bt709/bt709'] (matrix/transfer/primaries) */
export async function frameColorTags(path: string): Promise<string[]> {
  // prettier-ignore
  const { stdout } = await exec(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'frame=color_space,color_transfer,color_primaries', '-of', 'json', path
  ], { maxBuffer: 64 * 1024 * 1024 })
  const { frames } = JSON.parse(stdout) as {
    frames: { color_space?: string; color_transfer?: string; color_primaries?: string }[]
  }
  const label = (f: (typeof frames)[number]): string =>
    [f.color_space, f.color_transfer, f.color_primaries].map((v) => v ?? 'unknown').join('/')
  return [...new Set(frames.map(label))]
}

/** presentation time of the first frame whose average luma is above mid-grey (a white flash) */
export async function flashTime(path: string): Promise<number | null> {
  // prettier-ignore
  const { stdout } = await exec(FFMPEG, [
    '-v', 'error', '-nostdin', '-i', path, '-an',
    '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'
  ], { maxBuffer: 64 * 1024 * 1024 })
  // "frame:21 pts:… pts_time:0.7" followed by "lavfi.signalstats.YAVG=235"
  const lines = stdout.split(/\r?\n/)
  for (let i = 0; i + 1 < lines.length; i++) {
    const time = /pts_time:([\d.]+)/.exec(lines[i])?.[1]
    const luma = /YAVG=([\d.]+)/.exec(lines[i + 1])?.[1]
    if (time !== undefined && luma !== undefined && Number(luma) > 128) return Number(time)
  }
  return null
}

/** time of the first audio sample louder than `threshold` (full scale = 1), mixed to mono */
export async function beepTime(path: string, threshold = 0.25): Promise<number | null> {
  // prettier-ignore
  const { stdout } = await exec(
    FFMPEG,
    ['-v', 'error', '-nostdin', '-i', path, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }
  )
  const pcm = stdout as Buffer
  const limit = threshold * 32768
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    if (Math.abs(pcm.readInt16LE(i)) > limit) return i / 2 / 48000
  }
  return null
}

/** times (s) where a packet of the first audio stream does not start where the previous one ended */
export async function audioTimestampJumps(path: string): Promise<number[]> {
  // prettier-ignore
  const { stdout } = await exec(FFPROBE, [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'packet=pts_time,duration_time',
    '-of', 'csv=p=0', path
  ], { maxBuffer: 16 * 1024 * 1024 })
  const packets = stdout
    .split(/\r?\n/)
    .map((line) =>
      line
        .split(',')
        .filter((field) => field !== '')
        .map(Number)
    )
    .filter((fields) => fields.length === 2)
  const jumps: number[] = []
  for (let i = 1; i < packets.length; i++) {
    const [start] = packets[i]
    const [previous, duration] = packets[i - 1]
    if (Math.abs(start - (previous + duration)) > 1e-5) jumps.push(start)
  }
  return jumps
}

/** the first audio stream decoded and mixed to mono, 48 kHz */
export async function decodedMono(path: string): Promise<Int16Array> {
  // prettier-ignore
  const { stdout } = await exec(
    FFMPEG,
    ['-v', 'error', '-nostdin', '-i', path, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }
  )
  const bytes = stdout as Buffer
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2)
}

/** number of decoded audio samples (per channel) of the first audio stream */
export async function decodedAudioSamples(path: string): Promise<number> {
  // prettier-ignore
  const { stdout } = await exec(
    FFMPEG,
    ['-v', 'error', '-nostdin', '-i', path, '-map', '0:a:0', '-ac', '1', '-f', 's16le', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }
  )
  return (stdout as Buffer).length / 2
}

/** decodes the whole file; returns ffmpeg's error output (empty = clean) */
export async function decodeErrors(path: string): Promise<string> {
  const { stderr } = await exec(FFMPEG, ['-v', 'error', '-nostdin', '-i', path, '-f', 'null', '-'])
  return stderr.trim()
}

/** order of the top-level MP4 boxes, e.g. ['ftyp', 'moov', 'free', 'mdat'] */
export async function topLevelBoxes(path: string): Promise<string[]> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const boxes: string[] = []
    let position = 0
    const header = Buffer.alloc(16)
    while (position + 8 <= size && boxes.length < 32) {
      await handle.read(header, 0, 16, position)
      let boxSize = header.readUInt32BE(0)
      boxes.push(header.toString('latin1', 4, 8))
      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8))
      if (boxSize === 0) break
      position += boxSize
    }
    return boxes
  } finally {
    await handle.close()
  }
}

/** luma statistics of a horizontal band of the frame at `atSec` */
export async function bandLuma(
  path: string,
  atSec: number,
  band: { y: number; height: number }
): Promise<{ min: number; max: number; avg: number }> {
  // prettier-ignore
  const { stdout } = await exec(
    FFMPEG,
    [
      '-v', 'error', '-nostdin', '-ss', String(atSec), '-i', path, '-frames:v', '1',
      '-vf', `crop=iw:${band.height}:0:${band.y},format=gray`, '-f', 'rawvideo', '-'
    ],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }
  )
  const pixels = stdout as Buffer
  let min = 255
  let max = 0
  let sum = 0
  for (const value of pixels) {
    if (value < min) min = value
    if (value > max) max = value
    sum += value
  }
  return { min, max, avg: sum / Math.max(1, pixels.length) }
}

/**
 * Picture NAL unit types of an HEVC stream in decoding order, e.g. 20 IDR, 21 CRA, 8/9 RASL
 * (leading pictures of a CRA), 0/1 trailing pictures
 */
export async function hevcPictureTypes(path: string): Promise<number[]> {
  // prettier-ignore
  const { stderr } = await exec(FFMPEG, [
    '-hide_banner', '-nostdin', '-i', path, '-map', '0:v:0', '-c', 'copy',
    '-bsf:v', 'trace_headers', '-f', 'null', '-'
  ], { maxBuffer: 256 * 1024 * 1024 })
  return [...stderr.matchAll(/trace_headers.*\bnal_unit_type\s+\d+\s+=\s+(\d+)/g)]
    .map((match) => Number(match[1]))
    .filter((type) => type < 32)
}

/** average luma of a horizontal band for `count` frames from frame `first` on (output order) */
export async function bandLumas(
  path: string,
  band: { y: number; height: number },
  frames: { first: number; count: number }
): Promise<number[]> {
  const { first, count } = frames
  const filters =
    `trim=start_frame=${first}:end_frame=${first + count},crop=iw:${band.height}:0:${band.y},` +
    'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-'
  // prettier-ignore
  const { stdout } = await exec(FFMPEG, [
    '-v', 'error', '-nostdin', '-i', path, '-an', '-vf', filters, '-f', 'null', '-'
  ], { maxBuffer: 16 * 1024 * 1024 })
  return stdout
    .split(/\r?\n/)
    .map((line) => /YAVG=([\d.]+)/.exec(line)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
}

/**
 * Average PSNR (dB) of the first `frames` frames of `path` against `reference` scaled to the same
 * size – ~10 dB means different pictures (e.g. not rotated), > 30 dB the same picture. Compares
 * the stored YUV values: both inputs get the same colour tags first, otherwise ffmpeg converts
 * between differently tagged inputs (untagged source vs. BT.709 proxy) before comparing.
 */
export async function psnrAgainst(
  path: string,
  reference: string,
  size: { width: number; height: number },
  frames = 30
): Promise<number> {
  const sameTags = 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv'
  const graph =
    `[0:v]${sameTags}[out];[1:v]scale=${size.width}:${size.height},${sameTags}[ref];` +
    '[out][ref]psnr'
  // prettier-ignore
  const { stderr } = await exec(FFMPEG, [
    '-nostdin', '-i', path, '-i', reference,
    '-filter_complex', graph, '-frames:v', String(frames), '-f', 'null', '-'
  ])
  const match = /PSNR .*average:([\d.]+|inf)/.exec(stderr)
  if (!match) throw new Error(`no PSNR in ffmpeg output: ${stderr.slice(-500)}`)
  return match[1] === 'inf' ? Infinity : Number(match[1])
}

/** true when the encoded H.264 stream carries libx264's version SEI */
export async function encodedWithX264(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const buffer = Buffer.alloc(Math.min(size, 4 * 1024 * 1024))
    await handle.read(buffer, 0, buffer.length, 0)
    return buffer.includes('x264 - core')
  } finally {
    await handle.close()
  }
}

/** ffmpeg processes whose command line mentions `needle` */
export async function processesMentioning(needle: string): Promise<string[]> {
  try {
    const { stdout } = await exec('/usr/bin/pgrep', ['-fl', needle])
    return stdout.split('\n').filter((line) => line.includes('ffmpeg'))
  } catch {
    return [] // pgrep exits 1 when nothing matches
  }
}
