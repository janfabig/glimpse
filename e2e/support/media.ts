// Test videos (src/main/media/testVideos.ts) and ffprobe/ffmpeg checks of the exported files.

import { execFile } from 'node:child_process'
import { copyFile, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  ensureTestVideos,
  type TestVideoKey,
  type TestVideoSet
} from '../../src/main/media/testVideos'
import { FFMPEG, FFPROBE, TEST_VIDEO_DIR } from './env'

export type { TestVideo, TestVideoKey, TestVideoSet } from '../../src/main/media/testVideos'

const run = promisify(execFile)

/** the test clips, created once and cached in .cache/test-videos (shared with the media tests) */
export async function ensureVideos(): Promise<TestVideoSet> {
  return ensureTestVideos(TEST_VIDEO_DIR, { ffmpegPath: FFMPEG })
}

/**
 * Copies a test video under a new name. A fresh mtime gives the copy its own fingerprint, so it
 * never counts as a duplicate of the original.
 */
export async function copyVideo(source: string, dir: string, fileName: string): Promise<string> {
  const target = join(dir, fileName)
  await copyFile(source, target)
  const now = new Date()
  await utimes(target, now, now)
  return target
}

export interface ProbedStream {
  codec_type: 'video' | 'audio' | string
  codec_name?: string
  codec_tag_string?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  duration?: string
}

export interface ProbedFile {
  streams: ProbedStream[]
  format: { duration?: string; format_name?: string; size?: string }
}

export async function ffprobe(path: string): Promise<ProbedFile> {
  const { stdout } = await run(
    FFPROBE,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    { maxBuffer: 4 * 1024 * 1024 }
  )
  return JSON.parse(stdout) as ProbedFile
}

export interface ExportFacts {
  durationSec: number
  video: ProbedStream
  audio: ProbedStream | undefined
}

export async function probeExport(path: string): Promise<ExportFacts> {
  const info = await ffprobe(path)
  const video = info.streams.find((stream) => stream.codec_type === 'video')
  if (!video) throw new Error(`${path} has no video stream`)
  return {
    durationSec: Number(info.format.duration),
    video,
    audio: info.streams.find((stream) => stream.codec_type === 'audio')
  }
}

/**
 * Left-channel tone of every test clip (mirrors the generator in testVideos.ts: 440 Hz, 330 Hz
 * mono with short beeps, 523 Hz, no audio). In an export, the tone tells which video a clip is from.
 */
export const TEST_TONES: Record<TestVideoKey, number> = {
  portrait: 440,
  portraitHevc: 330,
  rotated: 523,
  landscapeSilent: 0
}

const SAMPLE_RATE = 48_000
/** samples within this distance of zero do not count as a sign change (AAC noise, silence) */
const HYSTERESIS = 300

/** pitch of the left audio channel in [start, start + seconds) from its zero crossings; 0 = silence */
export async function leftChannelPitch(path: string, start: number, seconds = 1): Promise<number> {
  const { stdout } = await run(
    FFMPEG,
    [
      ...['-v', 'error', '-ss', start.toFixed(3), '-t', String(seconds), '-i', path],
      ...['-map', '0:a:0', '-af', 'pan=mono|c0=c0', '-ar', String(SAMPLE_RATE)],
      ...['-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1']
    ],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }
  )
  const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2))
  if (samples.length === 0) return 0
  let sign = 0
  let crossings = 0
  for (const sample of samples) {
    const next = sample > HYSTERESIS ? 1 : sample < -HYSTERESIS ? -1 : 0
    if (next === 0) continue
    if (sign !== 0 && next !== sign) crossings++
    sign = next
  }
  return crossings / 2 / (samples.length / SAMPLE_RATE)
}

/** file name → tone of every test clip; copies are added under their own names */
export function tonesByFileName(
  videos: TestVideoSet,
  copies: Record<string, TestVideoKey> = {}
): Map<string, number> {
  const table = new Map(
    Object.values(videos).map((video) => [video.fileName, TEST_TONES[video.key]])
  )
  for (const [fileName, key] of Object.entries(copies)) table.set(fileName, TEST_TONES[key])
  return table
}

/** the known tone closest to `hz` */
export function nearestTone(hz: number): number {
  const tones = [...new Set(Object.values(TEST_TONES))]
  return tones.reduce((best, tone) => (Math.abs(tone - hz) < Math.abs(best - hz) ? tone : best))
}

/**
 * Tone in the middle of every clip of an exported reel, where it plays alone (up to 1 s, clear of
 * the crossfades). `durations` are the clip lengths in output order, `overlap` the crossfade length
 * (0 for hard cuts).
 */
export async function reelTones(
  path: string,
  durations: number[],
  overlap: number
): Promise<number[]> {
  const tones: number[] = []
  let start = 0
  for (const duration of durations) {
    const middle = start + duration / 2
    const alone = Math.min(1, duration - 2 * overlap - 0.1)
    tones.push(nearestTone(await leftChannelPitch(path, Math.max(0, middle - alone / 2), alone)))
    start += duration - overlap
  }
  return tones
}
