import { stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { ProbeResult } from '../contracts'
import { MediaError } from '../contracts'
import type { ColorInfo } from './color'
import { environmentFailure, fsFailure, MESSAGES, tailLines } from './errors'
import { LOCAL_VIDEO_INPUT } from './ffargs'
import { runProcess } from './runner'

/** The subset of `ffprobe -print_format json -show_format -show_streams` output we use. */
export interface RawStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  pix_fmt?: string
  start_time?: string
  duration?: string
  color_space?: string
  color_transfer?: string
  color_primaries?: string
  tags?: Record<string, string>
  side_data_list?: {
    side_data_type?: string
    rotation?: number | string
    /** the 3×3 matrix as ffprobe prints it: three "0000000n: a b c" lines */
    displaymatrix?: string
  }[]
  disposition?: Record<string, number>
}

export interface RawProbe {
  streams?: RawStream[]
  format?: { start_time?: string; duration?: string; size?: string; tags?: Record<string, string> }
}

export type QuarterTurn = 0 | 90 | 180 | 270

/** A ProbeResult plus what the media module needs internally (never leaves the module). */
export interface SourceInfo {
  probe: ProbeResult
  color: ColorInfo
  /** end of the first video stream in seconds from the file start (the `-ss` timeline); null if unknown */
  videoEndSec: number | null
  /** ffprobe's pixel format of the video stream, e.g. yuv420p, yuv420p10le; null if unknown */
  pixFmt: string | null
  /**
   * clockwise turn that makes the stored picture upright – null when the display matrix also
   * mirrors or turns by an odd angle (only ffmpeg's autorotation handles those)
   */
  quarterTurn: QuarterTurn | null
}

const FALLBACK_FPS = 30

/** Case-insensitive tag lookup (MKV writes CREATION_TIME, MP4 creation_time). */
function findTag(tags: Record<string, string> | undefined, key: string): string | undefined {
  if (!tags) return undefined
  const wanted = key.toLowerCase()
  for (const [name, value] of Object.entries(tags)) {
    if (name.toLowerCase() === wanted) return value
  }
  return undefined
}

function normalizeQuarterTurn(degrees: number): QuarterTurn {
  const quarter = Math.round(degrees / 90) * 90
  return (((quarter % 360) + 360) % 360) as QuarterTurn
}

function displayMatrixOf(
  stream: RawStream
): NonNullable<RawStream['side_data_list']>[number] | undefined {
  return stream.side_data_list?.find((d) => d.side_data_type === 'Display Matrix')
}

/**
 * Clockwise display rotation (0/90/180/270), i.e. the legacy `rotate` tag convention: an iPhone
 * portrait clip is 90. ffprobe's Display Matrix `rotation` is counter-clockwise (-90 for the same
 * clip), so it is negated.
 */
export function rotationOf(stream: RawStream): QuarterTurn {
  const matrix = displayMatrixOf(stream)
  const fromMatrix = Number(matrix?.rotation)
  if (matrix && Number.isFinite(fromMatrix)) return normalizeQuarterTurn(-fromMatrix)
  const fromTag = Number(findTag(stream.tags, 'rotate'))
  return Number.isFinite(fromTag) ? normalizeQuarterTurn(fromTag) : 0
}

/** the nine values of ffprobe's `displaymatrix` text, row by row; null if it cannot be read */
export function parseDisplayMatrix(text: string | undefined): number[] | null {
  if (!text) return null
  const values = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[0-9a-f]+:/i, '').trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => line.split(/\s+/).map(Number))
  return values.length === 9 && values.every(Number.isFinite) ? values : null
}

/**
 * rotationOf() when the display matrix is a pure quarter turn – the case explicit rotation filters
 * reproduce exactly. null for a mirroring matrix (negative determinant), an odd angle or a matrix
 * that cannot be read.
 */
export function quarterTurnOf(stream: RawStream): QuarterTurn | null {
  const matrix = displayMatrixOf(stream)
  if (!matrix) {
    const fromTag = Number(findTag(stream.tags, 'rotate') ?? 0)
    if (!Number.isFinite(fromTag) || Math.abs(fromTag - Math.round(fromTag / 90) * 90) > 1) {
      return null
    }
    return normalizeQuarterTurn(fromTag)
  }
  const angle = Number(matrix.rotation)
  const values = parseDisplayMatrix(matrix.displaymatrix)
  if (!Number.isFinite(angle) || values === null) return null
  if (values[0] * values[4] - values[1] * values[3] <= 0) return null
  if (Math.abs(angle - Math.round(angle / 90) * 90) > 1) return null
  return normalizeQuarterTurn(-angle)
}

/** "30000/1001" → 29.97, "25" → 25; null for "0/0", garbage or implausible values */
export function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null
  const [num, den = '1'] = value.split('/')
  const rate = Number(num) / Number(den)
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) return null
  return Math.round(rate * 1000) / 1000
}

const EARLIEST_PLAUSIBLE_YEAR = 1990

/** "2026-07-12T20:00:00(.123)" read as wall-clock time of this Mac on that date (DST included) */
function localWallTime(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/.exec(value)
  if (!match) return new Date(Number.NaN)
  const [, year, month, day, hours, minutes, seconds = '0', fraction = '0'] = match
  const ms = Math.round(Number(fraction) * 1000)
  return new Date(+year, +month - 1, +day, +hours, +minutes, +seconds, ms)
}

/**
 * Normalises a container date tag to an ISO string. Accepts ffprobe's UTC form
 * ("2026-07-12T19:14:05.000000Z"), Apple's local form with offset ("2026-07-12T21:14:05+0200")
 * and values that MOV writers duplicate with ";". Dates without a zone are taken as UTC (like
 * QuickTime's own creation_time) – or, with `zoneless: 'local'`, as wall-clock time of this Mac,
 * which then also applies to "Z" (ffprobe adds it to every QuickTime date, whatever the camera
 * stored). Explicit offsets always count. Placeholder dates (1904/1970 epochs) yield null.
 */
export function parseCreationTime(
  value: string | undefined,
  zoneless: 'utc' | 'local' = 'utc'
): string | null {
  const first = value
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.length > 0)
  if (!first) return null
  let normalized = first.replace(/^(\d{4}-\d{2}-\d{2})[ T]/, '$1T')
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) normalized += 'T00:00:00'
  const hasOffset = /[+-]\d{2}:?\d{2}$/.test(normalized)
  const date =
    zoneless === 'local' && !hasOffset
      ? localWallTime(normalized.replace(/[zZ]$/, ''))
      : new Date(hasOffset || /[zZ]$/.test(normalized) ? normalized : `${normalized}Z`)
  const time = date.getTime()
  if (Number.isNaN(time) || date.getUTCFullYear() < EARLIEST_PLAUSIBLE_YEAR) return null
  return date.toISOString()
}

// Cameras that store local wall-clock time in the QuickTime dates (which have no zone): GoPro and
// DJI. Recognised by their track handler names ("GoPro AVC", "DJI.AVC"), GoPro's firmware tag
// ("HD9.01.01.60.00", "H22.01.01.20.00") or DJI's encoder tag.
const LOCAL_TIME_HANDLER = /^[^a-z]*(?:gopro|dji)\b/i
const GOPRO_FIRMWARE = /^(?:HD\d|H\d{2})\.\d{2}\./
const DJI_ENCODER = /^DJI\b/i

/** true for files from cameras whose creation_time is local wall-clock time, not UTC */
export function isLocalTimeCamera(raw: RawProbe): boolean {
  const handlers = (raw.streams ?? []).map((s) => findTag(s.tags, 'handler_name') ?? '')
  if (handlers.some((name) => LOCAL_TIME_HANDLER.test(name))) return true
  const firmware = findTag(raw.format?.tags, 'firmware')?.trim() ?? ''
  const encoder = findTag(raw.format?.tags, 'encoder')?.trim() ?? ''
  return GOPRO_FIRMWARE.test(firmware) || DJI_ENCODER.test(encoder)
}

function isRealVideo(stream: RawStream): boolean {
  return stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1
}

function positiveNumber(value: string | number | undefined): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function finiteNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const UNSPECIFIED_COLOR = new Set(['unknown', 'unspecified', 'reserved'])

export function colorInfoOf(stream: RawStream): ColorInfo {
  const known = (value: string | undefined): string | null =>
    value && !UNSPECIFIED_COLOR.has(value) ? value : null
  return {
    matrix: known(stream.color_space),
    transfer: known(stream.color_transfer),
    primaries: known(stream.color_primaries)
  }
}

/**
 * Where the video stream ends on the timeline `-ss` seeks on (relative to the file start, i.e.
 * the earliest stream). Audio can outlast the video, so this may be less than the duration.
 */
export function videoEndOf(video: RawStream, format: RawProbe['format']): number | null {
  const duration = positiveNumber(video.duration)
  if (duration === null) return null
  const fileStart = finiteNumber(format?.start_time) ?? 0
  const videoStart = finiteNumber(video.start_time) ?? fileStart
  return Math.max(0, videoStart - fileStart) + duration
}

/** Pure mapping of ffprobe JSON to a ProbeResult; throws MediaError('probe'). */
export function parseProbe(raw: RawProbe, fileSizeBytes: number): ProbeResult {
  return parseSourceInfo(raw, fileSizeBytes).probe
}

/** parseProbe plus colour tags and the video stream's end; throws MediaError('probe'). */
export function parseSourceInfo(raw: RawProbe, fileSizeBytes: number): SourceInfo {
  const streams = raw.streams ?? []
  const video = streams.find(isRealVideo)
  if (!video) throw new MediaError('probe', MESSAGES.noVideoStream)
  const storedWidth = positiveNumber(video.width)
  const storedHeight = positiveNumber(video.height)
  if (!storedWidth || !storedHeight) throw new MediaError('probe', MESSAGES.unreadable)

  const durationSec =
    positiveNumber(raw.format?.duration) ??
    streams.reduce<number | null>((max, s) => {
      const d = positiveNumber(s.duration)
      return d !== null && (max === null || d > max) ? d : max
    }, null)
  if (durationSec === null) throw new MediaError('probe', MESSAGES.noDuration)

  const rotation = rotationOf(video)
  const quarterTurned = rotation === 90 || rotation === 270
  const audio = streams.find((s) => s.codec_type === 'audio')
  // Apple's capture date carries its offset; creation_time is UTC, except from cameras that
  // store local time (GoPro, DJI) – read as this Mac's local time for that date
  const zoneless = isLocalTimeCamera(raw) ? 'local' : 'utc'
  const recordedAt =
    parseCreationTime(findTag(raw.format?.tags, 'com.apple.quicktime.creationdate')) ??
    [raw.format?.tags, video.tags, audio?.tags]
      .map((tags) => parseCreationTime(findTag(tags, 'creation_time'), zoneless))
      .find((date) => date !== null) ??
    null

  const probe: ProbeResult = {
    durationSec,
    width: quarterTurned ? storedHeight : storedWidth,
    height: quarterTurned ? storedWidth : storedHeight,
    fps: parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate) ?? FALLBACK_FPS,
    videoCodec: video.codec_name ?? 'unknown',
    hasAudio: audio !== undefined,
    recordedAt,
    sizeBytes: positiveNumber(raw.format?.size) ?? fileSizeBytes
  }
  return {
    probe,
    color: colorInfoOf(video),
    videoEndSec: videoEndOf(video, raw.format),
    pixFmt: video.pix_fmt ?? null,
    quarterTurn: quarterTurnOf(video)
  }
}

async function runFfprobeJson(
  ffprobe: string,
  args: readonly string[],
  signal?: AbortSignal
): Promise<RawProbe> {
  const result = await runProcess(
    ffprobe,
    ['-v', 'error', ...LOCAL_VIDEO_INPUT, '-print_format', 'json', ...args],
    {
      captureStdout: true,
      signal,
      timeoutMs: 60_000
    }
  )
  if (result.code !== 0) {
    const path = args.at(-1)
    const denied = path ? environmentFailure(result.stderr, { inputs: [path] }) : null
    throw new MediaError('probe', denied ?? MESSAGES.unreadable, tailLines(result.stderr))
  }
  try {
    return JSON.parse(result.stdout) as RawProbe
  } catch {
    throw new MediaError('probe', MESSAGES.unreadable, 'ffprobe returned invalid JSON')
  }
}

export async function inspectSource(
  ffprobe: string,
  path: string,
  signal?: AbortSignal
): Promise<SourceInfo> {
  let sizeBytes: number
  try {
    sizeBytes = (await stat(path)).size
  } catch (err) {
    const message = fsFailure(err, dirname(path), 'read') ?? MESSAGES.missingFile(basename(path))
    throw new MediaError('probe', message, String(err))
  }
  const raw = await runFfprobeJson(ffprobe, ['-show_format', '-show_streams', path], signal)
  return parseSourceInfo(raw, sizeBytes)
}

export async function probeFile(
  ffprobe: string,
  path: string,
  signal?: AbortSignal
): Promise<ProbeResult> {
  return (await inspectSource(ffprobe, path, signal)).probe
}

export interface MediaDurations {
  formatSec: number | null
  /** first video / audio stream */
  videoSec: number | null
  audioSec: number | null
}

/** Container and stream durations – used to measure intermediates and verify the output. */
export async function probeDurations(
  ffprobe: string,
  path: string,
  signal?: AbortSignal
): Promise<MediaDurations> {
  const raw = await runFfprobeJson(
    ffprobe,
    ['-show_entries', 'format=duration:stream=codec_type,duration', path],
    signal
  )
  const streams = raw.streams ?? []
  const streamDuration = (type: string): number | null =>
    positiveNumber(streams.find((s) => s.codec_type === type)?.duration)
  return {
    formatSec: positiveNumber(raw.format?.duration),
    videoSec: streamDuration('video'),
    audioSec: streamDuration('audio')
  }
}
