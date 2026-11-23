// Integration tests of renderHighlight against real ffmpeg on generated test videos. The reels are
// small (360 px short side) to keep the suite fast and light on memory; one smoke test renders the
// app's 4K frame (EXPORT_FIXED). Outputs are verified with ffprobe and a full decode.
import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_EXPORT_SETTINGS, EXPORT_FIXED } from '@shared/presets'
import type { ExportSettings } from '@shared/types'
import type { RenderClip, RenderJob, RenderProgress } from '../contracts'
import { createMediaService } from './index'
import { clipTiming } from './render/clip'
import {
  audioTimestampJumps,
  bandLuma,
  bandLumas,
  beepTime,
  decodedAudioSamples,
  decodedMono,
  decodeErrors,
  FFMPEG,
  ffprobe,
  flashTime,
  frameColorTags,
  hevcPictureTypes,
  processesMentioning,
  TEST_VIDEO_DIR
} from './testHelpers'
import type { EdgeSources } from './testSources'
import {
  HLG_SOURCE,
  LATE_VIDEO,
  makeEdgeSources,
  makeOpenGopSource,
  OPEN_GOP,
  openGopFrame
} from './testSources'
import type { TestVideo, TestVideoSet } from './testVideos'
import { ensureTestVideos } from './testVideos'

const media = createMediaService({ logger: { warn: () => undefined } })
let videos: TestVideoSet
let root: string
let jobCounter = 0

beforeAll(async () => {
  videos = await ensureTestVideos(TEST_VIDEO_DIR, { ffmpegPath: FFMPEG })
  root = await mkdtemp(join(tmpdir(), 'hc-render-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function clip(video: TestVideo, start: number, end: number): RenderClip {
  return {
    sourcePath: video.path,
    start,
    end,
    hasAudio: video.hasAudio,
    sourceWidth: video.width,
    sourceHeight: video.height
  }
}

function job(clips: RenderClip[], patch: Partial<ExportSettings> = {}): RenderJob {
  const id = ++jobCounter
  return {
    clips,
    settings: { ...DEFAULT_EXPORT_SETTINGS, ...patch },
    frame: { shortSide: 360, fps: 30 },
    outputPath: join(root, `out-${id}`, `Highlights ${id}.mp4`),
    workDir: join(root, `work-${id}`)
  }
}

/** portrait H.264 + 60 fps landscape without audio + rotated + HEVC/mono: 1.5 + 1 + 1 + 1 = 4.5 s */
function mixedClips(): RenderClip[] {
  return [
    clip(videos.portrait, 2, 3.5),
    clip(videos.landscapeSilent, 1, 2),
    clip(videos.rotated, 4, 5),
    clip(videos.portraitHevc, 3, 4)
  ]
}

const sum = (clips: RenderClip[]): number => clips.reduce((s, c) => s + c.end - c.start, 0)

async function expectReel(
  path: string,
  expected: {
    width: number
    height: number
    durationSec: number
    tolerance: number
  }
): Promise<void> {
  const probed = await ffprobe(path)
  expect(probed.video.codec_name).toBe('h264')
  expect([probed.video.width, probed.video.height]).toEqual([expected.width, expected.height])
  expect(probed.video.avg_frame_rate).toBe('30/1')
  expect(Math.abs(probed.durationSec - expected.durationSec)).toBeLessThanOrEqual(
    expected.tolerance
  )
  expect(probed.audio).toMatchObject({ codec_name: 'aac', channels: 2, sample_rate: '48000' })
  expect(Math.abs(Number(probed.audio?.duration) - expected.durationSec)).toBeLessThanOrEqual(
    expected.tolerance
  )
  // gapless audio timeline (players follow the packet timestamps)
  expect(await audioTimestampJumps(path)).toEqual([])
  expect(await decodeErrors(path)).toBe('')
}

async function expectOnlyOutput(outputPath: string): Promise<void> {
  const folder = join(outputPath, '..')
  expect(await readdir(folder)).toEqual([outputPath.slice(folder.length + 1)])
}

describe('renderHighlight', () => {
  it('joins mixed clips with hard cuts (9:16 crop, clip without audio)', async () => {
    const clips = mixedClips()
    const reel = job(clips)
    const events: RenderProgress[] = []
    const result = await media.renderHighlight(reel, { onProgress: (p) => events.push(p) })

    expect(result.outputPath).toBe(reel.outputPath)
    expect(result.sizeBytes).toBe((await stat(reel.outputPath)).size)
    expect(result.durationSec).toBeCloseTo(sum(clips), 1)
    await expectReel(reel.outputPath, {
      width: 360,
      height: 640,
      durationSec: sum(clips),
      tolerance: 0.15
    })
    const counted = await ffprobe(reel.outputPath, { countPackets: true })
    expect(Number(counted.video.nb_read_packets)).toBe(135)
    await expectOnlyOutput(reel.outputPath)

    // progress: clips in order, then joining, then finishing; monotonic up to 1
    const phases = [...new Set(events.map((e) => e.phase))]
    expect(phases).toEqual(['rendering', 'joining', 'finishing'])
    const clipIndices = [
      ...new Set(events.filter((e) => e.phase === 'rendering').map((e) => e.clipIndex))
    ]
    expect(clipIndices).toEqual([0, 1, 2, 3])
    const fractions = events.map((e) => e.fraction)
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions)
    expect(fractions.at(-1)).toBe(1)
    expect(events.every((e) => e.clipCount === 4)).toBe(true)
  })

  it('crossfades: duration = Σd − (n−1)·T', async () => {
    const clips = mixedClips()
    const reel = job(clips, { transition: 'crossfade' })
    const result = await media.renderHighlight(reel, {})
    const expected = sum(clips) - (clips.length - 1) * EXPORT_FIXED.crossfadeSec
    expect(result.durationSec).toBeCloseTo(expected, 1)
    await expectReel(reel.outputPath, {
      width: 360,
      height: 640,
      durationSec: expected,
      tolerance: 0.25
    })
    await expectOnlyOutput(reel.outputPath)
  })

  it('crossfades frame- and sample-exactly: every frame of four clips where it belongs', async () => {
    // four sources whose every frame n has one flat luma, 20 + 4 · ((n + phase) mod 50), and a
    // tone of their own – so each frame of the reel tells which source frames it shows
    const phases = [20, 12, 37, 25]
    const tones = [300, 500, 700, 900]
    const sources: string[] = []
    for (const [i, phase] of phases.entries()) {
      const path = join(root, `ramp-${i}.mp4`)
      // prettier-ignore
      await promisify(execFile)(FFMPEG, [
        '-v', 'error', '-y', '-f', 'lavfi', '-i',
        `color=c=black:s=320x180:r=30:d=2.4,format=yuv420p,geq=lum='20+4*mod(N+${phase},50)':cb=128:cr=128`,
        '-f', 'lavfi', '-i', `sine=f=${tones[i]}:sample_rate=48000:d=2.4`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-c:a', 'aac', '-b:a', '128k', path
      ])
      sources.push(path)
    }
    // 1.5 s, 1 s, 1.5 s and 2 s, each from source frame 6
    const lengths = [45, 30, 45, 60]
    const clips = lengths.map((frames, i) => ({
      sourcePath: sources[i],
      start: 0.2,
      end: 0.2 + frames / 30,
      hasAudio: true,
      sourceWidth: 320,
      sourceHeight: 180
    }))
    const reel = job(clips, { aspect: '16:9', transition: 'crossfade' })
    const events: RenderProgress[] = []
    await media.renderHighlight(reel, { onProgress: (p) => events.push(p) })

    // exact length: Σd − 3 transitions of 12 frames, as many samples as frames
    const total = 180 - 3 * 12
    const counted = await ffprobe(reel.outputPath, { countPackets: true })
    expect(Number(counted.video.nb_read_packets)).toBe(total)
    expect(await decodedAudioSamples(reel.outputPath)).toBe(total * 1600)
    await expectReel(reel.outputPath, {
      width: 640,
      height: 360,
      durationSec: total / 30,
      tolerance: 0.03
    })

    // picture: clip i shows luma(i, j) at its frame j; inside a transition the two clips are mixed
    const luma = (i: number, j: number): number => 20 + 4 * ((6 + j + phases[i]) % 50)
    const expected: number[] = []
    for (const [i, frames] of lengths.entries()) {
      const fadeIn = i === 0 ? 0 : 12
      const fadeOut = i === lengths.length - 1 ? 0 : 12
      for (let j = fadeIn; j < frames - fadeOut; j++) expected.push(luma(i, j))
      for (let j = 0; j < fadeOut; j++) {
        const mix = j / 12
        expected.push(luma(i, frames - 12 + j) * (1 - mix) + luma(i + 1, j) * mix)
      }
    }
    expect(expected).toHaveLength(total)
    const shown = await bandLumas(
      reel.outputPath,
      { y: 0, height: 360 },
      { first: 0, count: total }
    )
    expect(shown).toHaveLength(total)
    // a doubled or missing frame would be off by 4 or more from there on (mixing and encoding
    // round by up to 2)
    const wrong = shown.flatMap((value, frame) =>
      frame >= 15 && frame < total - 15 && Math.abs(value - expected[frame]) > 2.5
        ? [`frame ${frame}: ${value} instead of ${expected[frame]}`]
        : []
    )
    expect(wrong).toEqual([])
    // the reel fades in from black and out to black (0.5 s each)
    expect(shown[0]).toBeLessThan(20)
    expect(shown[7]).toBeGreaterThan(40)
    expect(shown[7]).toBeLessThan(expected[7] - 30)
    expect(shown[total - 8]).toBeLessThan(expected[total - 8] - 30)
    expect(shown[total - 1]).toBeLessThan(32)

    // sound: alone in the middle of what a clip shows alone, both clips in the middle of a fade
    const pcm = await decodedMono(reel.outputPath)
    const share = (atFrame: number): number[] => {
      const from = atFrame * 1600 - 2400
      const power = tones.map((hz) => {
        let re = 0
        let im = 0
        for (let n = 0; n < 4800; n++) {
          re += pcm[from + n] * Math.cos((2 * Math.PI * hz * n) / 48_000)
          im += pcm[from + n] * Math.sin((2 * Math.PI * hz * n) / 48_000)
        }
        return re * re + im * im
      })
      const all = power.reduce((sum, value) => sum + value, 0)
      return power.map((value) => value / all)
    }
    for (const [i, atFrame] of [24, 48, 73, 112].entries()) {
      expect(share(atFrame)[i], `clip ${i} alone`).toBeGreaterThan(0.95)
    }
    for (const [i, atFrame] of [39, 57, 90].entries()) {
      const mixed = share(atFrame)
      expect(mixed[i], `fade ${i}: leaving clip`).toBeGreaterThan(0.25)
      expect(mixed[i + 1], `fade ${i}: coming clip`).toBeGreaterThan(0.25)
    }
    // no click anywhere: a jump between two samples stays what a 900 Hz tone can do
    let peak = 0
    let jump = 0
    for (let n = 0; n < pcm.length; n++) {
      peak = Math.max(peak, Math.abs(pcm[n]))
      if (n > 0) jump = Math.max(jump, Math.abs(pcm[n] - pcm[n - 1]))
    }
    expect(jump / peak).toBeLessThan(0.3)

    // every intermediate is deleted once its segment exists; the bar never moves back
    expect((await readdir(reel.workDir)).filter((name) => name.startsWith('clip-'))).toEqual([])
    expect([...new Set(events.map((e) => e.phase))]).toEqual(['rendering', 'joining', 'finishing'])
    const fractions = events.map((e) => e.fraction)
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions)
    expect(fractions.at(-1)).toBe(1)
  })

  it('renders the 4K frame of the app: two clips of 1 s with a hard cut', async () => {
    // the only render at full size: 4K needs about 1.3 GB per clip and several times real time
    const clips = [clip(videos.portrait, 2, 3), clip(videos.rotated, 4, 5)]
    const reel = { ...job(clips), frame: EXPORT_FIXED }
    await media.renderHighlight(reel, {})
    await expectReel(reel.outputPath, { width: 2160, height: 3840, durationSec: 2, tolerance: 0.1 })
  })

  it('fits landscape footage on a blurred background instead of cropping', async () => {
    const clips = [clip(videos.landscapeSilent, 2, 3.5)]
    const blur = job(clips, { fit: 'blur' })
    const crop = job(clips, { fit: 'crop' })
    await media.renderHighlight(blur, {})
    await media.renderHighlight(crop, {})
    await expectReel(blur.outputPath, {
      width: 360,
      height: 640,
      durationSec: 1.5,
      tolerance: 0.15
    })

    // 0.75 s: between the fade in and the fade out (0.5 s each)
    // top band: smooth blurred colour with blur, the sharp cell pattern with crop
    const top = { y: 0, height: 60 }
    const blurred = await bandLuma(blur.outputPath, 0.75, top)
    const cropped = await bandLuma(crop.outputPath, 0.75, top)
    expect(blurred.avg).toBeGreaterThan(30)
    expect(blurred.max - blurred.min).toBeLessThan(80)
    expect(cropped.max - cropped.min).toBeGreaterThan(150)
    // middle band: the fitted (sharp) frame is visible in both (its cells are 5 times smaller at
    // 360 px, so less contrast is left than in the cropped frame)
    const middle = await bandLuma(blur.outputPath, 0.75, { y: 300, height: 40 })
    expect(middle.max - middle.min).toBeGreaterThan(120)
  })

  it("uses the first clip's aspect for 'source'", async () => {
    const clips = [clip(videos.rotated, 0, 1), clip(videos.portrait, 10, 11)]
    const reel = job(clips, { aspect: 'source' })
    await media.renderHighlight(reel, {})
    await expectReel(reel.outputPath, { width: 360, height: 640, durationSec: 2, tolerance: 0.15 })
  })

  it('cancels while rendering clips: process killed, nothing left behind', async () => {
    const reel = job(mixedClips())
    const controller = new AbortController()
    const run = media.renderHighlight(reel, {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === 'rendering' && p.fraction > 0) controller.abort()
      }
    })
    await expect(run).rejects.toMatchObject({ code: 'cancelled', message: 'Cancelled.' })
    expect(await processesMentioning(reel.workDir)).toEqual([])
    await expect(stat(reel.outputPath)).rejects.toThrow()
    const outputDir = join(reel.outputPath, '..')
    expect(await readdir(outputDir).catch(() => [])).toEqual([])
  })

  it('cancels while a crossfade segment renders: process killed, export folder untouched', async () => {
    const clips = [
      clip(videos.portrait, 0, 1.5),
      clip(videos.rotated, 2, 3.5),
      clip(videos.portrait, 12, 13.5)
    ]
    const reel = job(clips, { transition: 'crossfade' })
    const controller = new AbortController()
    let sawJoin = false
    const run = media.renderHighlight(reel, {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === 'joining') {
          sawJoin = true
          controller.abort()
        }
      }
    })
    await expect(run).rejects.toMatchObject({ code: 'cancelled' })
    expect(sawJoin).toBe(true)
    expect(await processesMentioning(reel.workDir)).toEqual([])
    expect(await readdir(join(reel.outputPath, '..'))).toEqual([])
  })

  it('cancels while the segments are joined: the temp output is removed', async () => {
    for (const transition of ['cut', 'crossfade'] as const) {
      const reel = job([clip(videos.portrait, 0, 1.5), clip(videos.rotated, 2, 3.5)], {
        transition
      })
      const outputDir = join(reel.outputPath, '..')
      const controller = new AbortController()
      let sawOutput = false
      const run = media.renderHighlight(reel, {
        signal: controller.signal,
        onProgress: (p) => {
          // the join writes a hidden temp file into the export folder
          if (p.phase === 'joining' && readdirSync(outputDir).length > 0) {
            sawOutput = true
            controller.abort()
          }
        }
      })
      await expect(run, transition).rejects.toMatchObject({ code: 'cancelled' })
      expect(sawOutput, transition).toBe(true)
      expect(await processesMentioning(reel.workDir), transition).toEqual([])
      expect(await readdir(outputDir), transition).toEqual([])
    }
  })

  it('exports short reels whose audio is digital silence', async () => {
    // loudnorm turns all-zero audio shorter than 3 s into NaN; the join must still succeed
    const silentTrack = join(root, 'silent-track.mp4')
    // prettier-ignore
    await promisify(execFile)(FFMPEG, [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', silentTrack
    ])
    const video = {
      ...videos.landscapeSilent,
      path: silentTrack,
      width: 640,
      height: 360,
      hasAudio: true
    }
    const warn = vi.fn()
    const watched = createMediaService({ logger: { warn } })
    for (const transition of ['cut', 'crossfade'] as const) {
      const reel = job([clip(video, 0, 1.2), clip(video, 1.2, 2.4)], { transition })
      await watched.renderHighlight(reel, {})
      expect(warn).toHaveBeenLastCalledWith(
        expect.stringContaining('without loudnorm'),
        expect.anything()
      )
      await expectReel(reel.outputPath, {
        width: 360,
        height: 640,
        durationSec: transition === 'cut' ? 2.4 : 2,
        tolerance: 0.15
      })
    }
  })

  it('names a missing source file', async () => {
    const missing = { ...clip(videos.portrait, 0, 2), sourcePath: join(root, 'gone.mp4') }
    await expect(media.renderHighlight(job([missing]), {})).rejects.toMatchObject({
      code: 'invalid',
      message: 'The file “gone.mp4” was not found.'
    })
  })

  it('names a source file that is no video', async () => {
    const notVideo = join(root, 'broken.mp4')
    await writeFile(notVideo, 'not a video')
    const broken = { ...clip(videos.portrait, 0, 2), sourcePath: notVideo }
    await expect(media.renderHighlight(job([broken]), {})).rejects.toMatchObject({
      code: 'probe',
      message: 'The file “broken.mp4” could not be read. Is it a supported video?'
    })
  })

  it('fails fast with a hint when the export folder is not writable', async () => {
    const locked = join(root, 'locked')
    await mkdir(locked, { mode: 0o555 })
    const reel = { ...job([clip(videos.portrait, 0, 2)]), outputPath: join(locked, 'reel.mp4') }
    const started = Date.now()
    await expect(media.renderHighlight(reel, {})).rejects.toMatchObject({
      code: 'invalid',
      message: `The export folder “${locked}” cannot be written to. Choose another folder.`
    })
    expect(Date.now() - started).toBeLessThan(1000)
    await chmod(locked, 0o755)
  })

  it('never replaces an existing video: a name taken meanwhile gets the next number', async () => {
    const reel = job([clip(videos.portrait, 0, 1)])
    const folder = join(reel.outputPath, '..')
    await mkdir(folder, { recursive: true })
    // another export finished under the same name (here in other letter case) while this one ran
    const taken = join(folder, `${'highlights'.toUpperCase()} ${jobCounter}.mp4`)
    await writeFile(taken, 'other reel')
    const sameFile = await stat(reel.outputPath).then(
      () => true,
      () => false
    )
    const result = await media.renderHighlight(reel, {})
    const expected = sameFile ? reel.outputPath.replace(/\.mp4$/, ' (2).mp4') : reel.outputPath
    expect(result.outputPath).toBe(expected)
    expect(result.sizeBytes).toBe((await stat(result.outputPath)).size)
    expect(await readFile(taken, 'utf8')).toBe('other reel')
    await expectReel(result.outputPath, {
      width: 360,
      height: 640,
      durationSec: 1,
      tolerance: 0.1
    })
  })

  it('rejects an empty job', async () => {
    await expect(media.renderHighlight(job([]), {})).rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('renderHighlight with edge-case sources', () => {
  let edge: EdgeSources

  beforeAll(async () => {
    edge = await makeEdgeSources(await mkdtemp(join(root, 'edge-')))
  })

  const sourceClip = (
    path: string,
    size: { width: number; height: number },
    start: number,
    end: number
  ): RenderClip => ({
    sourcePath: path,
    start,
    end,
    hasAudio: true,
    sourceWidth: size.width,
    sourceHeight: size.height
  })
  const small = { width: 320, height: 180 }
  const hlgClip = (start: number, end: number): RenderClip =>
    sourceClip(edge.hlg, HLG_SOURCE, start, end)

  it('keeps picture and sound in sync when the video stream starts after the audio', async () => {
    // a first clip without the event takes the fade in: the clip after it is cut as it is
    const lead = sourceClip(edge.lateVideo, small, 1.5, 2)
    // 0.8: the whole pre-roll (0.5 s) is decoded and dropped again – frames and samples alike
    for (const start of [0, 0.2, 0.8]) {
      const reel = job([lead, sourceClip(edge.lateVideo, small, start, 2)], { aspect: '16:9' })
      await media.renderHighlight(reel, {})
      const expected = 0.5 + LATE_VIDEO.eventSec - start
      // the flash is frame-exact, the beep sample-exact (± AAC)
      expect(await flashTime(reel.outputPath), `clip from ${start}`).toBeCloseTo(expected, 3)
      expect(await beepTime(reel.outputPath), `clip from ${start}`).toBeCloseTo(expected, 2)
    }
  })

  it('holds the last frame for clips after the end of the video stream (audio goes on)', async () => {
    // 3 s of video, 4 s of audio: 3.2–3.8 has sound but no picture of its own
    const clips = [
      sourceClip(edge.shortVideo, small, 1, 2),
      sourceClip(edge.shortVideo, small, 3.2, 3.8)
    ]
    for (const transition of ['cut', 'crossfade'] as const) {
      const reel = job(clips, { aspect: '16:9', transition })
      const result = await media.renderHighlight(reel, {})
      // crossfade: 0.4 s capped at half the 0.6 s clip
      const expected = transition === 'cut' ? 1.6 : 1.6 - 0.3
      expect(result.durationSec, transition).toBeCloseTo(expected, 1)
      await expectReel(reel.outputPath, {
        width: 640,
        height: 360,
        durationSec: expected,
        tolerance: 0.05
      })
      if (transition === 'cut') {
        const counted = await ffprobe(reel.outputPath, { countPackets: true })
        expect(Number(counted.video.nb_read_packets)).toBe(30 + 18)
      }
      // the held frame is the source's last picture, not black (0.32 s: before the fade out)
      const held = await bandLuma(reel.outputPath, expected - 0.32, { y: 100, height: 160 })
      expect(held.max - held.min, transition).toBeGreaterThan(100)
    }
  })

  it('renders the last moment of a 1 fps timelapse (its last frame starts 1 s before the end)', async () => {
    const reel = job([sourceClip(edge.timelapse, small, 3.6, 4)], { aspect: '16:9' })
    await media.renderHighlight(reel, {})
    await expectReel(reel.outputPath, {
      width: 640,
      height: 360,
      durationSec: 0.4,
      tolerance: 0.05
    })
  })

  it('cuts clips that end exactly at the end of a source frame- and sample-exactly', async () => {
    const portraitEnd = (await media.probe(videos.portrait.path)).durationSec
    const landscapeEnd = (await media.probe(videos.landscapeSilent.path)).durationSec
    // two frames, the very last ones of the source – first and last: x264 gives such tiny
    // intermediates no B-frame delay, which must not disturb the joined timestamps
    const lastTwoFrames = clip(videos.portrait, portraitEnd - 2 / 30, portraitEnd)
    const clips = [
      lastTwoFrames,
      clip(videos.portrait, portraitEnd - 1.5, portraitEnd),
      clip(videos.landscapeSilent, landscapeEnd - 1, landscapeEnd),
      lastTwoFrames
    ]
    const reel = job(clips)
    await media.renderHighlight(reel, {})

    const timings = clips.map((c) => clipTiming(c.start, c.end, 30))
    expect(timings.map((t) => t.frames)).toEqual([2, 45, 30, 2])
    for (const [index, timing] of timings.entries()) {
      // every intermediate has exactly as many frames as samples allow – no drift in the join
      const intermediate = await ffprobe(join(reel.workDir, `clip-00${index}.mov`), {
        countPackets: true
      })
      expect(Number(intermediate.video.nb_read_packets), `clip ${index}`).toBe(timing.frames)
      expect(Math.round(Number(intermediate.audio?.duration) * 48_000), `clip ${index}`).toBe(
        timing.samples
      )
    }
    const total = timings.reduce((sum, t) => sum + t.frames, 0)
    const counted = await ffprobe(reel.outputPath, { countPackets: true })
    expect(Number(counted.video.nb_read_packets)).toBe(total)
    expect(await decodedAudioSamples(reel.outputPath)).toBe(total * 1600)
    await expectReel(reel.outputPath, {
      width: 360,
      height: 640,
      durationSec: total / 30,
      tolerance: 0.03
    })
  })

  it('tone-maps HLG clips and tags every frame of the reel BT.709 (cut, crossfade, blur)', async () => {
    const sdr = clip(videos.portrait, 2, 3.5)
    // hlgAt: a moment of the HLG clip outside the fade in, the fade out and the crossfade
    const cases = [
      { clips: [sdr, hlgClip(0.5, 2)], hlgAt: 2.2, patch: { transition: 'cut' } },
      { clips: [hlgClip(0.5, 2), sdr], hlgAt: 0.8, patch: { transition: 'crossfade' } },
      // portrait HLG on a blurred 16:9 background: both branches are tone-mapped
      { clips: [hlgClip(0.5, 2)], hlgAt: 0.7, patch: { aspect: '16:9', fit: 'blur' } }
    ] satisfies { clips: RenderClip[]; hlgAt: number; patch: Partial<ExportSettings> }[]
    for (const { clips, hlgAt, patch } of cases) {
      const label = JSON.stringify(patch)
      const reel = job(clips, patch)
      await media.renderHighlight(reel, {})
      const { video } = await ffprobe(reel.outputPath)
      expect(video, label).toMatchObject({
        color_range: 'tv',
        color_space: 'bt709',
        color_transfer: 'bt709',
        color_primaries: 'bt709'
      })
      expect(await frameColorTags(reel.outputPath), label).toEqual(['bt709/bt709/bt709'])
      expect(await decodeErrors(reel.outputPath), label).toBe('')
      // HLG reference white (75 % signal) ends up near-white, as in an SDR recording
      const grey = await bandLuma(reel.outputPath, hlgAt, { y: 280, height: 40 })
      expect(grey.avg, label).toBeGreaterThan(215)
    }
  })
})

describe('renderHighlight with open-GOP HEVC', () => {
  let source: string
  const size = { width: OPEN_GOP.width, height: OPEN_GOP.height }
  // output frames are 640×360 like the source: its top band is 64 px
  const band = { y: 8, height: 48 }
  const framesOf = async (path: string, first: number, count: number): Promise<number[]> =>
    (await bandLumas(path, band, { first, count })).map(openGopFrame)
  const openGopClip = (start: number, end: number): RenderClip => ({
    sourcePath: source,
    start,
    end,
    hasAudio: true,
    sourceWidth: size.width,
    sourceHeight: size.height
  })
  /** source frames n…n+4 as the band shows them (mod 50) */
  const expectedFrames = (n: number): number[] => [0, 1, 2, 3, 4].map((i) => (n + i) % 50)

  beforeAll(async () => {
    source = await makeOpenGopSource(await mkdtemp(join(root, 'open-gop-')))
  })

  it('starts clips 3 frames before a CRA keyframe on the right frame (cut and crossfade)', async () => {
    // the source is open-GOP: every keyframe after the first is a CRA whose leading pictures
    // (RASL) cannot be decoded when a seek lands on it – with ffmpeg 9 a plain `-ss 1.9` does,
    // and frames 57–59 show the keyframe picture
    const pictures = await hevcPictureTypes(source)
    const cra = pictures.flatMap((type, i) => (type === 21 ? [i] : []))
    expect(cra.length).toBe(2)
    expect(cra.every((i) => [8, 9].includes(pictures[i + 1]))).toBe(true)

    // clips from 1.9 s (keyframe at 2 s) and 3.9 s (keyframe at 4 s), 30 frames each, after a
    // first clip of 15 frames that takes the fade in (the band tells the frame by its brightness)
    const clips = [openGopClip(0.2, 0.7), openGopClip(1.9, 2.9), openGopClip(3.9, 4.9)]
    const cut = job(clips, { aspect: '16:9' })
    await media.renderHighlight(cut, {})
    expect(await framesOf(cut.outputPath, 15, 5)).toEqual(expectedFrames(57))
    expect(await framesOf(cut.outputPath, 45, 5)).toEqual(expectedFrames(117))
    await expectReel(cut.outputPath, {
      width: 640,
      height: 360,
      durationSec: 2.5,
      tolerance: 0.05
    })

    // the crossfade deletes each intermediate once its segment is rendered: stop before the first
    const crossfade = job(clips, { aspect: '16:9', transition: 'crossfade' })
    const controller = new AbortController()
    await expect(
      media.renderHighlight(crossfade, {
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === 'joining') controller.abort()
        }
      })
    ).rejects.toMatchObject({ code: 'cancelled' })
    for (const [index, start] of [57, 117].entries()) {
      const intermediate = join(crossfade.workDir, `clip-00${index + 1}.mov`)
      expect(await framesOf(intermediate, 0, 5), `clip ${index + 1}`).toEqual(expectedFrames(start))
    }
  })
})
