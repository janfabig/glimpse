// Export pipeline: render every clip into an intermediate with identical parameters (size, fps,
// SDR BT.709 colour, codec settings, PCM audio), then join them by stream copy. For crossfades the
// intermediates are first turned into segments that hold the fades (two clips per ffmpeg run, final
// encode), so memory does not grow with the number of clips. The job names the frame and the frame
// rate (the app passes EXPORT_FIXED); the reel always fades in and out and is loudness-normalised.
// The output is written to a hidden temp file next to the target and renamed at the end, so a
// cancelled or failed export never leaves a half-written video behind.

import { constants } from 'node:fs'
import { access, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { EXPORT_FIXED } from '@shared/presets'
import type { RenderJob, RenderProgress, RenderResult } from '../../contracts'
import { MediaError } from '../../contracts'
import type { SdrConversion } from '../color'
import { describeTransfer, sdrConversion } from '../color'
import { fsFailure, MESSAGES, throwIfAborted } from '../errors'
import { ensureDir, fileSize, namingFullOutputFolder, writeNewFile } from '../fsutil'
import type { Size } from '../geometry'
import { targetSize } from '../geometry'
import type { SourceInfo } from '../probe'
import { inspectSource, probeDurations } from '../probe'
import { runFfmpeg } from '../runner'
import type { Toolchain } from '../toolchain'
import type { ClipTiming } from './clip'
import { clipArgs, clipFilterGraph, clipTiming, latestFrameSeek } from './clip'
import type { VideoEncoderSpec } from './encoders'
import { finalVideoEncoder, mezzanineEncoder } from './encoders'
import type { RenderProgressTracker } from './progress'
import { createRenderProgress } from './progress'
import { concatJoinArgs, concatList, crossfadeSegmentArgs, crossfadeSegments } from './join'

export interface RenderOptions {
  onProgress?: (progress: RenderProgress) => void
  signal?: AbortSignal
}

function validateJob(job: RenderJob): void {
  if (job.clips.length === 0) throw new MediaError('invalid', MESSAGES.noClips)
  job.clips.forEach((clip, index) => {
    const valid =
      Number.isFinite(clip.start) &&
      Number.isFinite(clip.end) &&
      clip.start >= 0 &&
      clip.end > clip.start
    if (!valid) throw new MediaError('invalid', MESSAGES.invalidClip(index))
  })
}

/** fail fast (before rendering for minutes) when the export folder cannot be written */
async function assertOutputWritable(outputPath: string): Promise<void> {
  const folder = dirname(outputPath)
  try {
    await mkdir(folder, { recursive: true })
    await access(folder, constants.W_OK)
  } catch (err) {
    throw new MediaError('invalid', MESSAGES.outputNotWritable(folder), String(err))
  }
}

async function assertSourcesExist(job: RenderJob): Promise<void> {
  for (const path of new Set(job.clips.map((clip) => clip.sourcePath))) {
    const exists = await stat(path).then(
      (info) => info.isFile(),
      () => false
    )
    if (!exists) throw new MediaError('invalid', MESSAGES.missingFile(basename(path)))
  }
}

/** Colour tags and video-stream ends of every source (one ffprobe per distinct file). */
async function inspectSources(
  tc: Toolchain,
  job: RenderJob,
  signal?: AbortSignal
): Promise<Map<string, SourceInfo>> {
  const sources = new Map<string, SourceInfo>()
  for (const path of new Set(job.clips.map((clip) => clip.sourcePath))) {
    try {
      sources.set(path, await inspectSource(tc.ffprobe, path, signal))
    } catch (err) {
      // keep messages that name a cause (missing permission), not just "unreadable"
      if (
        !(err instanceof MediaError) ||
        err.code !== 'probe' ||
        err.message !== MESSAGES.unreadable
      ) {
        throw err
      }
      throw new MediaError('probe', MESSAGES.unreadableFile(basename(path)), err.details)
    }
  }
  return sources
}

/** SDR BT.709 conversion per clip; warns once per HDR source that cannot be tone-mapped. */
function clipConversions(
  tc: Toolchain,
  job: RenderJob,
  sources: ReadonlyMap<string, SourceInfo>
): SdrConversion[] {
  const conversions = new Map<string, SdrConversion>()
  for (const [path, { probe, color }] of sources) {
    const conversion = sdrConversion(color, probe, tc.toneMapping)
    conversions.set(path, conversion)
    if (conversion.kind === 'untonemapped') {
      tc.log.warn(
        `render: ${describeTransfer(conversion.transfer)} source converted to SDR without tone ` +
          'mapping (ffmpeg lacks libswscale colour management)',
        path
      )
    }
  }
  return job.clips.map((clip) => conversions.get(clip.sourcePath) ?? { kind: 'none' })
}

interface ClipContext {
  target: Size
  timings: readonly ClipTiming[]
  conversions: readonly SdrConversion[]
  progress: RenderProgressTracker
  signal?: AbortSignal
}

async function renderClips(
  tc: Toolchain,
  job: RenderJob,
  ctx: ClipContext,
  encoder: VideoEncoderSpec
): Promise<string[]> {
  const { settings, clips } = job
  const paths: string[] = []
  for (const [index, clip] of clips.entries()) {
    throwIfAborted(ctx.signal)
    const timing = ctx.timings[index]
    const outPath = join(job.workDir, `clip-${String(index).padStart(3, '0')}.mov`)
    const graph = clipFilterGraph({
      target: ctx.target,
      source: { width: clip.sourceWidth, height: clip.sourceHeight },
      fps: job.frame.fps,
      fit: settings.fit,
      timing,
      hasAudio: clip.hasAudio,
      fadeIn: index === 0,
      fadeOut: index === clips.length - 1,
      conversion: ctx.conversions[index]
    })
    ctx.progress.clip(index, 0)
    await runFfmpeg(
      tc.ffmpeg,
      clipArgs({
        sourcePath: clip.sourcePath,
        timing,
        graph,
        videoEncoderArgs: encoder.args,
        outPath
      }),
      {
        errorMessage: MESSAGES.clipFailed(index, clips.length),
        durationSec: timing.durationSec,
        onProgress: (fraction) => ctx.progress.clip(index, fraction),
        signal: ctx.signal
      }
    )
    paths.push(outPath)
  }
  return paths
}

/** Real length of an intermediate in frames (the shorter of its video and audio streams). */
async function measuredFrames(
  tc: Toolchain,
  path: string,
  fps: number,
  signal?: AbortSignal
): Promise<number> {
  const d = await probeDurations(tc.ffprobe, path, signal)
  const seconds = Math.min(d.videoSec ?? Infinity, d.audioSec ?? Infinity, d.formatSec ?? Infinity)
  if (!Number.isFinite(seconds)) {
    throw new MediaError('ffmpeg', MESSAGES.join, `no duration: ${path}`)
  }
  return Math.max(1, Math.round(seconds * fps))
}

async function verifyOutput(tc: Toolchain, path: string, signal?: AbortSignal): Promise<number> {
  try {
    const d = await probeDurations(tc.ffprobe, path, signal)
    const seconds = d.formatSec ?? d.videoSec
    if (seconds === null) throw new MediaError('ffmpeg', MESSAGES.verify, 'output has no duration')
    return seconds
  } catch (err) {
    if (err instanceof MediaError && err.code === 'probe') {
      throw new MediaError('ffmpeg', MESSAGES.verify, err.details)
    }
    throw err
  }
}

export async function renderHighlight(
  tc: Toolchain,
  job: RenderJob,
  opts: RenderOptions = {}
): Promise<RenderResult> {
  const { signal } = opts
  const { settings, clips } = job
  validateJob(job)
  throwIfAborted(signal)
  await assertSourcesExist(job)
  await assertOutputWritable(job.outputPath)
  const sources = await inspectSources(tc, job, signal)

  const { fps, shortSide } = job.frame
  const target = targetSize(
    settings.aspect,
    { width: clips[0].sourceWidth, height: clips[0].sourceHeight },
    shortSide
  )
  const timings = clips.map((clip) => {
    const source = sources.get(clip.sourcePath)
    const latestSeek = source ? latestFrameSeek(source.videoEndSec, source.probe.fps) : null
    return clipTiming(clip.start, clip.end, fps, latestSeek)
  })
  const conversions = clipConversions(tc, job, sources)
  const crossfade = settings.transition === 'crossfade' && clips.length > 1
  const progress = createRenderProgress(
    timings.map((t) => t.durationSec),
    opts.onProgress
  )
  const finalEncoder = finalVideoEncoder(target, fps, tc)
  await ensureDir(job.workDir)

  // With hard cuts the intermediates are the final video stream (joined by stream copy), so they
  // are encoded with the final settings; crossfades re-encode them into segments, so near-lossless
  // intermediates.
  const intermediates = await renderClips(
    tc,
    job,
    { target, timings, conversions, progress, signal },
    crossfade ? mezzanineEncoder(target, fps, tc) : finalEncoder
  )

  // reads the intermediates (and writes the crossfade segments and the concat list into the work
  // dir) before the export folder is touched
  const runJoin = await prepareJoin(tc, job, {
    intermediates,
    timings,
    crossfade,
    finalEncoder,
    progress,
    signal
  })
  // an existing file is never replaced (another export may have taken the name in the meantime);
  // everything in here writes into the export folder
  const { result, path } = await namingFullOutputFolder(job.outputPath, job.workDir, () =>
    writeNewFile(job.outputPath, async (tempPath) => {
      // a reel without any audio has nothing to normalise (and short silence would become NaN)
      const normalize = clips.some((clip) => clip.hasAudio)
      try {
        await runJoin(normalize, tempPath)
      } catch (err) {
        if (!normalize || !(err instanceof MediaError) || !isLoudnormSilenceFailure(err)) throw err
        tc.log.warn('render join: audio is digital silence, joining without loudnorm', err.details)
        await runJoin(false, tempPath)
      }
      progress.finishing()
      const durationSec = await verifyOutput(tc, tempPath, signal)
      return { durationSec, sizeBytes: await fileSize(tempPath) }
    })
  )
  return { outputPath: path, ...result }
}

/**
 * loudnorm (dynamic mode) emits NaN samples for audio that is digital silence and shorter than its
 * 3-second analysis window; the AAC encoder then fails with "Input contains (near) NaN/+-Inf".
 */
function isLoudnormSilenceFailure(err: MediaError): boolean {
  return err.code === 'ffmpeg' && /NaN\/\+-Inf/.test(err.details ?? '')
}

type JoinRunner = (normalize: boolean, outPath: string) => Promise<void>

/** part of the join's progress that rendering the crossfade segments takes; the copy gets the rest */
const SEGMENT_SHARE = 0.9

/**
 * Renders the segments of a crossfaded reel (see crossfadeSegments) one after the other: each
 * ffmpeg run opens two intermediates and encodes with the final settings. An intermediate is
 * deleted as soon as its segment exists, so the work dir never holds both sets completely.
 */
async function renderSegments(
  tc: Toolchain,
  job: RenderJob,
  ctx: {
    intermediates: readonly string[]
    finalEncoder: VideoEncoderSpec
    progress: RenderProgressTracker
    signal?: AbortSignal
  }
): Promise<{ paths: string[]; durationSec: number }> {
  const { intermediates, signal } = ctx
  const { fps } = job.frame
  const frames: number[] = []
  for (const path of intermediates) frames.push(await measuredFrames(tc, path, fps, signal))
  const segments = crossfadeSegments(frames, fps, EXPORT_FIXED.crossfadeSec)
  const totalFrames = segments.reduce((sum, segment) => sum + segment.frames, 0)
  const paths: string[] = []
  let doneFrames = 0
  for (const segment of segments) {
    throwIfAborted(signal)
    const outPath = join(job.workDir, `segment-${String(segment.clip).padStart(3, '0')}.mov`)
    await runFfmpeg(
      tc.ffmpeg,
      crossfadeSegmentArgs({
        clips: intermediates,
        segment,
        fps,
        videoEncoderArgs: ctx.finalEncoder.args,
        outPath
      }),
      {
        errorMessage: MESSAGES.join,
        durationSec: segment.frames / fps,
        onProgress: (fraction) =>
          ctx.progress.join(
            (SEGMENT_SHARE * (doneFrames + segment.frames * Math.max(0, fraction))) / totalFrames
          ),
        signal
      }
    )
    doneFrames += segment.frames
    paths.push(outPath)
    // best effort: a clip that stays only costs disk space until the work dir is removed
    await rm(intermediates[segment.clip], { force: true }).catch(() => undefined)
  }
  return { paths, durationSec: totalFrames / fps }
}

/**
 * Prepares what the join needs once (in the work dir) and returns a runner for the actual join,
 * which writes `outPath`.
 */
async function prepareJoin(
  tc: Toolchain,
  job: RenderJob,
  ctx: {
    intermediates: string[]
    timings: readonly ClipTiming[]
    crossfade: boolean
    finalEncoder: VideoEncoderSpec
    progress: RenderProgressTracker
    signal?: AbortSignal
  }
): Promise<JoinRunner> {
  const { signal, progress } = ctx
  const pieces = ctx.crossfade
    ? await renderSegments(tc, job, ctx)
    : {
        paths: ctx.intermediates,
        durationSec: ctx.timings.reduce((sum, t) => sum + t.durationSec, 0)
      }
  const listPath = join(job.workDir, 'concat.txt')
  await writeFile(listPath, concatList(pieces.paths), 'utf8').catch((err: unknown) => {
    const message = fsFailure(err, job.workDir, 'write')
    if (message === null) throw err
    throw new MediaError('ffmpeg', message, String(err))
  })
  const onProgress = ctx.crossfade
    ? (fraction: number) => progress.join(SEGMENT_SHARE + (1 - SEGMENT_SHARE) * fraction)
    : progress.join
  return (normalize, outPath) =>
    runFfmpeg(tc.ffmpeg, concatJoinArgs({ listPath, normalize, outPath }), {
      errorMessage: MESSAGES.join,
      onProgress,
      signal,
      durationSec: pieces.durationSec
    })
}
