// Integration tests against the repo's ffmpeg/ffprobe (vendor/ffmpeg) on generated test videos:
// status, probe, fingerprint, poster, proxy (hardware and software paths), analysis copy and sprite.
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MESSAGES } from './errors'
import { createMediaService } from './index'
import type { ProxyAttempt } from './proxy'
import { makeProxy } from './proxy'
import type { Toolchain } from './toolchain'
import { createToolchainLoader } from './toolchain'
import {
  bandLuma,
  beepTime,
  decodeErrors,
  encodedWithX264,
  FFMPEG,
  FFPROBE,
  ffprobe,
  flashTime,
  frameColorTags,
  frameTimes,
  keyframeTimes,
  psnrAgainst,
  topLevelBoxes,
  TEST_VIDEO_DIR
} from './testHelpers'
import type { EdgeSources } from './testSources'
import { HLG_SOURCE, LATE_VIDEO, makeEdgeSources } from './testSources'
import type { TestVideo, TestVideoSet } from './testVideos'
import { ensureTestVideos } from './testVideos'

const media = createMediaService()
const quiet = { warn: () => undefined }
let videos: TestVideoSet
let all: TestVideo[]
let tc: Toolchain
let dir: string

beforeAll(async () => {
  videos = await ensureTestVideos(TEST_VIDEO_DIR, { ffmpegPath: FFMPEG })
  all = Object.values(videos)
  tc = await createToolchainLoader({ logger: quiet }).ready()
  dir = await mkdtemp(join(tmpdir(), 'hc-media-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64'

describe('status', () => {
  it('finds the repo’s ffmpeg and the VideoToolbox encoder', async () => {
    const status = await media.status()
    expect(status.ok).toBe(true)
    // the app's lookup (vitest.config.mts: HC_FFMPEG/HC_FFPROBE) finds the same copy as the tests
    expect(status.ffmpegPath).toBe(FFMPEG)
    expect(status.ffprobePath).toBe(FFPROBE)
    expect(status.version).toMatch(/\d/)
    expect(status.error).toBeUndefined()
    if (appleSilicon) {
      expect(status.hardwareEncoders).toEqual(['h264_videotoolbox'])
      expect(tc.hwDecode).toBe(true)
      expect(tc.gpuScaling).toBe(true)
    }
  })

  it('caches the detection', async () => {
    const started = Date.now()
    await media.status()
    expect(Date.now() - started).toBeLessThan(50)
  })

  it('can be told to stay off the hardware', async () => {
    const status = await createMediaService({ hardwareAcceleration: false }).status()
    expect(status.hardwareEncoders).toEqual([])
    const software = await createToolchainLoader({
      hardwareAcceleration: false,
      logger: quiet
    }).ready()
    expect([software.hwDecode, software.gpuScaling]).toEqual([false, false])
  })
})

describe('probe', () => {
  it('reads every test video', async () => {
    for (const video of all) {
      const result = await media.probe(video.path)
      expect(result, video.key).toMatchObject({
        width: video.width,
        height: video.height,
        fps: video.fps,
        videoCodec: video.videoCodec,
        hasAudio: video.hasAudio,
        recordedAt: video.recordedAt,
        sizeBytes: (await stat(video.path)).size
      })
      expect(result.durationSec).toBeCloseTo(video.durationSec, 1)
    }
  })

  it('names the folder of a video it may not read', async () => {
    const locked = join(dir, 'locked-source')
    await mkdir(locked)
    const copy = join(locked, 'clip.mp4')
    await writeFile(copy, await readFile(videos.rotated.path))
    await chmod(copy, 0o000)
    try {
      await expect(media.probe(copy)).rejects.toMatchObject({
        code: 'probe',
        message: MESSAGES.readDenied(locked)
      })
    } finally {
      await chmod(copy, 0o644)
    }
  })

  it('rejects files that are not videos', async () => {
    const notVideo = join(dir, 'notes.txt')
    await writeFile(notVideo, 'not a video')
    await expect(media.probe(notVideo)).rejects.toMatchObject({ code: 'probe' })
    await expect(media.probe(join(dir, 'missing.mp4'))).rejects.toMatchObject({
      code: 'probe',
      message: 'The file “missing.mp4” was not found.'
    })
  })
})

describe('fingerprint', () => {
  it('is stable and distinguishes files', async () => {
    const a = await media.fingerprint(videos.portrait.path)
    expect(a).toMatch(/^\d+-\d+-[0-9a-f]{40}$/)
    expect(await media.fingerprint(videos.portrait.path)).toBe(a)
    expect(await media.fingerprint(videos.rotated.path)).not.toBe(a)
  })
})

describe('makePoster', () => {
  it('writes an upright JPEG with the longest side ≤ 640', async () => {
    for (const video of all) {
      const out = join(dir, 'posters', `${video.key}.jpg`)
      await media.makePoster(video.path, out, 2)
      const { video: image } = await ffprobe(out)
      expect(image.codec_name).toBe('mjpeg')
      expect(Math.max(image.width ?? 0, image.height ?? 0)).toBe(640)
      // same orientation as the display size (the rotated clip is portrait)
      expect((image.width ?? 0) < (image.height ?? 0)).toBe(video.width < video.height)
    }
    expect((await readdir(join(dir, 'posters'))).sort()).toEqual(
      all.map((v) => `${v.key}.jpg`).sort()
    )
  })

  it('falls back to the first frame when the position is past the end', async () => {
    const out = join(dir, 'poster-late.jpg')
    await media.makePoster(videos.rotated.path, out, 999)
    expect((await ffprobe(out)).video.width).toBe(360)
  })
})

const gpu: ProxyAttempt = { encoder: 'h264_videotoolbox', hwDecode: true, gpuScale: true }

describe('makeProxy', () => {
  const vt: ProxyAttempt = { encoder: 'h264_videotoolbox', hwDecode: true }
  const sw: ProxyAttempt = { encoder: 'libx264', hwDecode: false }

  async function expectProxy(
    path: string,
    expected: { width: number; height: number; durationSec: number; audio: boolean }
  ): Promise<void> {
    const probed = await ffprobe(path)
    expect(probed.format.format_name).toContain('mp4')
    expect(probed.video.codec_name).toBe('h264')
    expect([probed.video.width, probed.video.height]).toEqual([expected.width, expected.height])
    expect(probed.video.side_data_list?.some((d) => d.rotation) ?? false).toBe(false)
    const [num, den] = (probed.video.avg_frame_rate ?? '0/1').split('/').map(Number)
    expect(num / den).toBeLessThanOrEqual(30.01)
    expect(probed.durationSec).toBeCloseTo(expected.durationSec, 1)
    if (expected.audio) {
      expect(probed.audio).toMatchObject({ codec_name: 'aac', channels: 2 })
    } else {
      expect(probed.audio).toBeUndefined()
    }
    // keyframe every second
    const keys = await keyframeTimes(path)
    expect(keys[0]).toBe(0)
    expect(keys.length).toBe(Math.ceil(expected.durationSec))
    for (let i = 1; i < keys.length; i++) expect(keys[i] - keys[i - 1]).toBeCloseTo(1, 1)
    // faststart: the index comes before the media data
    const boxes = await topLevelBoxes(path)
    expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'))
  }

  it.runIf(appleSilicon)('encodes with VideoToolbox and hardware decoding', async () => {
    const out = join(dir, 'proxy-vt.mp4')
    const fractions: number[] = []
    const used = await makeProxy(
      tc,
      videos.portrait.path,
      out,
      { durationSec: videos.portrait.durationSec, onProgress: (f) => fractions.push(f) },
      [vt]
    )
    expect(used).toEqual(vt)
    expect(await encodedWithX264(out)).toBe(false)
    expect(fractions.at(-1)).toBe(1)
    await expectProxy(out, { width: 720, height: 960, durationSec: 20, audio: true })
  })

  it('encodes with libx264 in software (60 fps → 30 fps, no audio)', async () => {
    const out = join(dir, 'proxy-sw.mp4')
    const used = await makeProxy(tc, videos.landscapeSilent.path, out, { durationSec: 12 }, [sw])
    expect(used).toEqual(sw)
    expect(await encodedWithX264(out)).toBe(true)
    await expectProxy(out, { width: 1280, height: 720, durationSec: 12, audio: false })
  })

  it.runIf(appleSilicon)(
    'uses GPU scaling by default (same picture as the classic path)',
    async () => {
      const out = (name: string): string => join(dir, `proxy-portrait-${name}.mp4`)
      const durationSec = videos.portrait.durationSec
      expect(await makeProxy(tc, videos.portrait.path, out('gpu'), { durationSec })).toEqual(gpu)
      await makeProxy(tc, videos.portrait.path, out('vt'), { durationSec }, [vt])
      await expectProxy(out('gpu'), { width: 720, height: 960, durationSec: 20, audio: true })
      // the picture matches the classic path (scaler details aside), and so do its levels
      const gpuFrames = await frameTimes(out('gpu'))
      expect(gpuFrames).toEqual(await frameTimes(out('vt')))
      expect(await psnrAgainst(out('gpu'), out('vt'), { width: 720, height: 960 })).toBeGreaterThan(
        35
      )
      const middle = { y: 400, height: 160 }
      const [a, b] = [await bandLuma(out('gpu'), 5, middle), await bandLuma(out('vt'), 5, middle)]
      expect(Math.abs(a.avg - b.avg)).toBeLessThan(1.5)
    }
  )

  it('applies the rotation on every path (picture upright, not squashed)', async () => {
    const attempts = appleSilicon ? [gpu, vt, sw] : [sw]
    for (const attempt of attempts) {
      const rotated = join(
        dir,
        `proxy-rotated-${attempt.encoder}${attempt.gpuScale ? '-gpu' : ''}.mp4`
      )
      await makeProxy(tc, videos.rotated.path, rotated, { durationSec: 10 }, [attempt])
      await expectProxy(rotated, { width: 720, height: 1280, durationSec: 10, audio: true })
      // the reference is decoded with ffmpeg's default autorotation
      const psnr = await psnrAgainst(rotated, videos.rotated.path, { width: 720, height: 1280 })
      expect(psnr, JSON.stringify(attempt)).toBeGreaterThan(30)
    }
  })

  it('leaves a mirrored display matrix to ffmpeg’s autorotation', async () => {
    // front-camera style: turned and mirrored – explicit rotation filters would lose the mirror
    const mirrored = join(dir, 'mirrored.mov')
    // prettier-ignore
    await promisify(execFile)(FFMPEG, [
      '-v', 'error', '-y', '-display_rotation:v:0', '-90', '-display_hflip:v:0',
      '-i', videos.rotated.path, '-t', '3', '-c', 'copy', mirrored
    ])
    const out = join(dir, 'proxy-mirrored.mp4')
    const used = await makeProxy(tc, mirrored, out, { durationSec: 3 })
    expect(used.gpuScale).toBeUndefined()
    // the reference is decoded with ffmpeg's default autorotation (mirror included)
    expect(await psnrAgainst(out, mirrored, { width: 720, height: 1280 })).toBeGreaterThan(30)
  })

  it('names the folder and does not retry when the proxy cannot be written', async () => {
    const locked = join(dir, 'locked-proxy')
    await mkdir(locked, { mode: 0o555 })
    const warn = vi.fn()
    try {
      const error = await makeProxy(
        { ...tc, log: { warn } },
        videos.portrait.path,
        join(locked, 'proxy.mp4'),
        {
          durationSec: 20
        }
      ).catch((err: unknown) => err)
      expect(error).toMatchObject({ code: 'ffmpeg', message: MESSAGES.writeDenied(locked) })
      expect(warn).not.toHaveBeenCalled()
      expect(await readdir(locked)).toEqual([])
    } finally {
      await chmod(locked, 0o755)
    }
  })

  it('normalises mono 44.1 kHz HEVC sources (service defaults)', async () => {
    const hevc = join(dir, 'proxy-hevc.mp4')
    await media.makeProxy(videos.portraitHevc.path, hevc, { durationSec: 14 })
    await expectProxy(hevc, { width: 720, height: 960, durationSec: 14, audio: true })
  })

  it('stops on abort and leaves nothing behind', async () => {
    const target = join(dir, 'cancel', 'proxy.mp4')
    const controller = new AbortController()
    const run = media.makeProxy(videos.portrait.path, target, {
      durationSec: 20,
      signal: controller.signal,
      onProgress: (f) => {
        if (f > 0) controller.abort()
      }
    })
    setTimeout(() => controller.abort(), 1500)
    await expect(run).rejects.toMatchObject({ code: 'cancelled' })
    expect(await readdir(join(dir, 'cancel'))).toEqual([])
  })
})

describe('makeProxy with edge-case sources', () => {
  const vt: ProxyAttempt = { encoder: 'h264_videotoolbox', hwDecode: true }
  const sw: ProxyAttempt = { encoder: 'libx264', hwDecode: false }
  let edge: EdgeSources

  beforeAll(async () => {
    edge = await makeEdgeSources(await mkdtemp(join(dir, 'edge-')))
  })

  /** the middle of the (flat grey) HLG frame */
  const centre = { y: HLG_SOURCE.height / 2 - 20, height: 40 }

  it('tone-maps an iPhone-like HLG clip to an upright SDR BT.709 proxy (every path)', async () => {
    expect(tc.toneMapping).toBe(true)
    for (const attempt of appleSilicon ? [gpu, vt, sw] : [sw]) {
      const out = join(dir, `proxy-hlg-${attempt.encoder}${attempt.gpuScale ? '-gpu' : ''}.mp4`)
      await makeProxy(tc, edge.hlg, out, { durationSec: HLG_SOURCE.durationSec }, [attempt])
      const { video } = await ffprobe(out)
      expect([video.width, video.height]).toEqual([HLG_SOURCE.width, HLG_SOURCE.height])
      expect(video, attempt.encoder).toMatchObject({
        pix_fmt: 'yuv420p',
        color_range: 'tv',
        color_space: 'bt709',
        color_transfer: 'bt709',
        color_primaries: 'bt709'
      })
      expect(await frameColorTags(out)).toEqual(['bt709/bt709/bt709'])
      // HLG reference white (75 % signal) becomes near-white SDR
      expect((await bandLuma(out, 1, centre)).avg, JSON.stringify(attempt)).toBeGreaterThan(215)
      expect(video.side_data_list ?? []).toEqual([])
    }
  })

  it.runIf(appleSilicon)(
    'keeps GPU-scaled proxies frame-exact and constant frame rate',
    async () => {
      // picture and sound of the late-video event stay together
      const late = join(dir, 'proxy-late-gpu.mp4')
      expect(await makeProxy(tc, edge.lateVideo, late, { durationSec: 3 }, [gpu])).toEqual(gpu)
      expect(Number((await ffprobe(late)).video.start_time)).toBe(0)
      expect(await flashTime(late)).toBeCloseTo(LATE_VIDEO.eventSec, 2)
      expect(await beepTime(late)).toBeCloseTo(LATE_VIDEO.eventSec, 2)

      // VFR becomes CFR with keyframes on the second marks
      const vfr = join(dir, 'proxy-vfr-gpu.mp4')
      expect(await makeProxy(tc, edge.vfr, vfr, { durationSec: 4 }, [gpu])).toEqual(gpu)
      const { video } = await ffprobe(vfr)
      expect([video.avg_frame_rate, video.r_frame_rate]).toEqual(['30000/1001', '30000/1001'])
      const times = await frameTimes(vfr)
      for (let i = 1; i < times.length; i++) {
        expect(times[i] - times[i - 1]).toBeCloseTo(1001 / 30000, 3)
      }
      const keys = await keyframeTimes(vfr)
      expect(keys[0]).toBe(0)
      for (let i = 1; i < keys.length; i++) expect(keys[i] - keys[i - 1]).toBeCloseTo(1, 1)
      expect(await decodeErrors(vfr)).toBe('')
    }
  )

  it('converts HLG without tone mapping (and warns) when ffmpeg cannot tone-map', async () => {
    const warn = vi.fn()
    const out = join(dir, 'proxy-hlg-plain.mp4')
    await makeProxy({ ...tc, toneMapping: false, log: { warn } }, edge.hlg, out, {
      durationSec: HLG_SOURCE.durationSec
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HLG'), edge.hlg)
    expect((await ffprobe(out)).video).toMatchObject({
      color_transfer: 'bt709',
      color_primaries: 'bt709'
    })
    // the plain conversion keeps the HLG signal level: visibly darker than the tone-mapped one
    const { avg } = await bandLuma(out, 1, centre)
    expect(avg).toBeGreaterThan(160)
    expect(avg).toBeLessThan(205)
  })

  it('makes VFR footage constant frame rate', async () => {
    const source = await media.probe(edge.vfr)
    expect(source.fps).toBeLessThan(29.9) // jittered: the average is no standard rate
    const out = join(dir, 'proxy-vfr.mp4')
    await media.makeProxy(edge.vfr, out, { durationSec: source.durationSec })
    const { video } = await ffprobe(out)
    expect(video.avg_frame_rate).toBe('30000/1001')
    expect(video.r_frame_rate).toBe('30000/1001')
    const times = await frameTimes(out)
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeCloseTo(1001 / 30000, 3)
    }
    const keys = await keyframeTimes(out)
    for (let i = 1; i < keys.length; i++) expect(keys[i] - keys[i - 1]).toBeCloseTo(1, 1)
    expect(await decodeErrors(out)).toBe('')
  })

  it('starts the timeline at 0 when the video stream starts after the audio', async () => {
    const out = join(dir, 'proxy-late.mp4')
    await media.makeProxy(edge.lateVideo, out, { durationSec: 3 })
    const { video, audio } = await ffprobe(out)
    expect(Number(video.start_time)).toBe(0)
    expect(Number(audio?.start_time)).toBe(0)
    // picture and sound of the event stay together
    expect(await flashTime(out)).toBeCloseTo(LATE_VIDEO.eventSec, 2)
    expect(await beepTime(out)).toBeCloseTo(LATE_VIDEO.eventSec, 2)
  })
})

describe('makeAnalysisCopy', () => {
  it('makes a 4 fps mono copy of a proxy: same picture size and length, smaller', async () => {
    const proxy = join(dir, 'copy-src.mp4')
    await media.makeProxy(videos.portrait.path, proxy, { durationSec: 20 })
    const copy = join(dir, 'analysis.mp4')
    await media.makeAnalysisCopy(proxy, copy, {})
    const [source, probed] = [await ffprobe(proxy), await ffprobe(copy)]
    expect(probed.video).toMatchObject({ codec_name: 'h264', avg_frame_rate: '4/1' })
    expect([probed.video.width, probed.video.height]).toEqual([
      source.video.width,
      source.video.height
    ])
    expect(probed.audio).toMatchObject({ codec_name: 'aac', channels: 1 })
    expect(Math.abs(probed.durationSec - source.durationSec)).toBeLessThan(0.1)
    expect((await stat(copy)).size).toBeLessThan((await stat(proxy)).size)
  })

  it('handles a proxy without audio', async () => {
    const proxy = join(dir, 'copy-silent-src.mp4')
    await media.makeProxy(videos.landscapeSilent.path, proxy, { durationSec: 12 })
    const copy = join(dir, 'analysis-silent.mp4')
    await media.makeAnalysisCopy(proxy, copy, {})
    const probed = await ffprobe(copy)
    expect(probed.video.avg_frame_rate).toBe('4/1')
    expect(probed.audio).toBeUndefined()
  })
})

describe('makeSprite', () => {
  it('builds a single-row filmstrip from a proxy', async () => {
    const proxy = join(dir, 'sprite-src.mp4')
    await media.makeProxy(videos.rotated.path, proxy, { durationSec: 10 })
    const out = join(dir, 'sprite.jpg')
    const info = await media.makeSprite(proxy, out, { durationSec: 10 })
    expect(info).toEqual({ columns: 10, intervalSec: 1, tileWidth: 160, tileHeight: 284 })
    const { video: image } = await ffprobe(out)
    expect([image.width, image.height]).toEqual([1600, 284])
  })
})
