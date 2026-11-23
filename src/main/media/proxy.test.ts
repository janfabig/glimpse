import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaError } from '../contracts'
import type { ColorInfo } from './color'
import { MESSAGES } from './errors'
import type { QuarterTurn } from './probe'
import type { ProxyAttempt, ProxySource } from './proxy'
import {
  analysisCopyArgs,
  gpuFramesOf,
  makeProxy,
  proxyArgs,
  proxyAttempts,
  proxyFrameRate
} from './proxy'
import type { Toolchain } from './toolchain'
import { LOCAL_VIDEO_INPUT } from './ffargs'

const runFfmpeg = vi.hoisted(() => vi.fn())
vi.mock('./runner', () => ({ runFfmpeg }))
const source = vi.hoisted(() => ({
  color: { matrix: null, transfer: null, primaries: null } as ColorInfo,
  pixFmt: 'yuv420p' as string | null,
  quarterTurn: 0 as QuarterTurn | null
}))
vi.mock('./probe', () => ({
  inspectSource: vi.fn(async () => ({
    probe: {
      durationSec: 12,
      width: 1440,
      height: 1920,
      fps: 30,
      videoCodec: 'h264',
      hasAudio: true,
      recordedAt: null,
      sizeBytes: 1
    },
    color: source.color,
    videoEndSec: 12,
    pixFmt: source.pixFmt,
    quarterTurn: source.quarterTurn
  }))
}))

const gpu: ProxyAttempt = { encoder: 'h264_videotoolbox', hwDecode: true, gpuScale: true }
const vt: ProxyAttempt = { encoder: 'h264_videotoolbox', hwDecode: true }
const sw: ProxyAttempt = { encoder: 'libx264', hwDecode: false }
const portrait: ProxySource = {
  width: 1440,
  height: 1920,
  fps: 30,
  hasAudio: true,
  conversion: { kind: 'none' },
  gpu: { format: 'nv12', turn: 0 }
}
const HLG: ColorInfo = { matrix: 'bt2020nc', transfer: 'arib-std-b67', primaries: 'bt2020' }
const BT709_TAGS = 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv'

const valueOf = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1]

describe('proxyAttempts', () => {
  const caps = { hardwareEncoders: ['h264_videotoolbox'], hwDecode: true, gpuScaling: true }

  it('prefers VideoToolbox with GPU scaling, then with downloaded frames, then libx264', () => {
    expect(proxyAttempts(caps)).toEqual([gpu, vt, sw])
    expect(proxyAttempts({ ...caps, gpuScaling: false })).toEqual([vt, sw])
    expect(proxyAttempts({ ...caps, hwDecode: false, gpuScaling: false })).toEqual([
      { encoder: 'h264_videotoolbox', hwDecode: false },
      sw
    ])
    expect(proxyAttempts({ ...caps, hardwareEncoders: [] })).toEqual([sw])
  })
})

describe('gpuFramesOf', () => {
  const info = (
    videoCodec: string,
    pixFmt: string | null,
    quarterTurn: QuarterTurn | null
  ): Parameters<typeof gpuFramesOf>[0] => ({ probe: { videoCodec }, pixFmt, quarterTurn })

  it('takes 8- and 10-bit 4:2:0 H.264/HEVC with a pure quarter turn', () => {
    expect(gpuFramesOf(info('h264', 'yuv420p', 0))).toEqual({ format: 'nv12', turn: 0 })
    expect(gpuFramesOf(info('h264', 'yuvj420p', 180))).toEqual({ format: 'nv12', turn: 180 })
    expect(gpuFramesOf(info('hevc', 'yuv420p10le', 90))).toEqual({ format: 'p010le', turn: 90 })
  })

  it('leaves everything else to the classic paths', () => {
    expect(gpuFramesOf(info('prores', 'yuv422p10le', 0))).toBeNull()
    expect(gpuFramesOf(info('hevc', 'yuv422p10le', 0))).toBeNull()
    expect(gpuFramesOf(info('h264', 'yuv444p', 0))).toBeNull()
    expect(gpuFramesOf(info('vp9', 'yuv420p', 0))).toBeNull()
    expect(gpuFramesOf(info('h264', null, 0))).toBeNull()
    // mirrored or odd display matrix: only ffmpeg's autorotation gets it right
    expect(gpuFramesOf(info('hevc', 'yuv420p', null))).toBeNull()
  })
})

describe('proxyFrameRate', () => {
  it('always yields a constant rate, capped at 30 fps, and keys every second', () => {
    expect(proxyFrameRate(30)).toEqual({ rate: '30', gop: 30 })
    expect(proxyFrameRate(25)).toEqual({ rate: '25', gop: 25 })
    expect(proxyFrameRate(24)).toEqual({ rate: '24', gop: 24 })
    expect(proxyFrameRate(60)).toEqual({ rate: '30', gop: 30 })
    expect(proxyFrameRate(120)).toEqual({ rate: '30', gop: 30 })
    expect(proxyFrameRate(0)).toEqual({ rate: '30', gop: 30 })
    expect(proxyFrameRate(Number.NaN)).toEqual({ rate: '30', gop: 30 })
  })

  it('snaps measured averages of VFR clips to the nearest standard rate', () => {
    expect(proxyFrameRate(29.97)).toEqual({ rate: '30000/1001', gop: 30 })
    expect(proxyFrameRate(29.95)).toEqual({ rate: '30000/1001', gop: 30 })
    expect(proxyFrameRate(29.814)).toEqual({ rate: '30000/1001', gop: 30 })
    expect(proxyFrameRate(30.02)).toEqual({ rate: '30', gop: 30 })
    expect(proxyFrameRate(30.4)).toEqual({ rate: '30', gop: 30 })
    expect(proxyFrameRate(23.976)).toEqual({ rate: '24000/1001', gop: 24 })
    expect(proxyFrameRate(24.3)).toEqual({ rate: '24', gop: 24 })
    expect(proxyFrameRate(24.7)).toEqual({ rate: '25', gop: 25 })
  })

  it('keeps unusual rates (hyperlapse, timelapse) as they are', () => {
    expect(proxyFrameRate(15)).toEqual({ rate: '15', gop: 15 })
    expect(proxyFrameRate(12.5)).toEqual({ rate: '12.5', gop: 13 })
    expect(proxyFrameRate(27.123456)).toEqual({ rate: '27.123', gop: 27 })
  })
})

describe('proxyArgs', () => {
  const TONEMAP =
    'scale=in_transfer=arib-std-b67:in_primaries=bt2020:in_color_matrix=bt2020:' +
    'out_transfer=bt709:out_primaries=bt709:out_color_matrix=bt709:out_range=tv'
  const hlg = {
    kind: 'tonemap',
    transfer: 'arib-std-b67',
    primaries: 'bt2020',
    matrix: 'bt2020'
  } as const

  it('builds the GPU-scaling command: fps and downscale before the download', () => {
    const args = proxyArgs('/in.mp4', '/out.mp4', portrait, gpu)
    // prettier-ignore
    expect(args.slice(0, 12)).toEqual([
      '-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld',
      '-noautorotate', '-display_rotation:v:0', '0', ...LOCAL_VIDEO_INPUT, '-i'
    ])
    expect(valueOf(args, '-vf')?.split(',')).toEqual([
      'fps=fps=30:start_time=0',
      'scale_vt=w=720:h=960',
      'hwdownload',
      'format=nv12',
      'scale=out_range=tv',
      'format=yuv420p',
      BT709_TAGS
    ])
    // everything else as on the classic VideoToolbox path
    const classic = proxyArgs('/in.mp4', '/out.mp4', portrait, vt)
    expect(args.slice(args.indexOf('-i'))).toEqual(
      classic
        .slice(classic.indexOf('-i'))
        .map((a) => (a === valueOf(classic, '-vf') ? valueOf(args, '-vf') : a))
    )
  })

  it('scales the stored picture, tone-maps it and turns the small frames upright', () => {
    // iPhone portrait 4K60 HLG: stored 3840×2160, shown 2160×3840 (90° clockwise)
    const iphone: ProxySource = {
      width: 2160,
      height: 3840,
      fps: 60,
      hasAudio: true,
      conversion: hlg,
      gpu: { format: 'p010le', turn: 90 }
    }
    expect(valueOf(proxyArgs('/in.mov', '/out.mp4', iphone, gpu), '-vf')?.split(',')).toEqual([
      'fps=fps=30:start_time=0',
      'scale_vt=w=1280:h=720',
      'hwdownload',
      'format=p010le',
      TONEMAP,
      'format=yuv420p',
      'transpose=clock',
      BT709_TAGS
    ])
    const turned = (turn: QuarterTurn): string | undefined =>
      valueOf(
        proxyArgs('/in.mov', '/out.mp4', { ...iphone, gpu: { format: 'p010le', turn } }, gpu),
        '-vf'
      )
    expect(turned(270)).toContain(`,format=yuv420p,transpose=cclock,${BT709_TAGS}`)
    expect(turned(180)).toContain('scale_vt=w=720:h=1280,')
    expect(turned(180)).toContain(`,format=yuv420p,hflip,vflip,${BT709_TAGS}`)
    expect(turned(0)).toContain(`,format=yuv420p,${BT709_TAGS}`)
  })

  it('refuses the GPU attempt for a source without GPU parameters', () => {
    expect(() => proxyArgs('/in.mp4', '/out.mp4', { ...portrait, gpu: null }, gpu)).toThrow()
  })

  it('builds the VideoToolbox command', () => {
    const args = proxyArgs('/in.mp4', '/out.mp4', portrait, vt)
    expect(args.slice(0, 8)).toEqual([
      '-hwaccel',
      'videotoolbox',
      ...LOCAL_VIDEO_INPUT,
      '-i',
      '/in.mp4'
    ])
    expect(valueOf(args, '-vf')).toBe(
      `fps=fps=30:start_time=0,scale=720:960:out_range=tv,format=yuv420p,${BT709_TAGS}`
    )
    expect(valueOf(args, '-c:v')).toBe('h264_videotoolbox')
    expect(valueOf(args, '-b:v')).toBe('2500k')
    expect(valueOf(args, '-g')).toBe('30')
    expect(valueOf(args, '-keyint_min')).toBe('30')
    expect(valueOf(args, '-force_key_frames')).toBe('expr:gte(t,n_forced*1)')
    expect(valueOf(args, '-c:a')).toBe('aac')
    expect(valueOf(args, '-b:a')).toBe('128k')
    expect(valueOf(args, '-ac')).toBe('2')
    expect(valueOf(args, '-movflags')).toBe('+faststart')
    expect(valueOf(args, '-map_metadata')).toBe('-1')
    expect(args.at(-1)).toBe('/out.mp4')
  })

  it('builds the software command', () => {
    const args = proxyArgs('/in.mp4', '/out.mp4', portrait, sw)
    expect(args).not.toContain('-hwaccel')
    expect(valueOf(args, '-c:v')).toBe('libx264')
    expect(valueOf(args, '-preset')).toBe('veryfast')
    expect(valueOf(args, '-crf')).toBe('26')
    expect(valueOf(args, '-sc_threshold')).toBe('0')
  })

  it('tags every proxy SDR BT.709, on the frames and in the stream', () => {
    for (const attempt of [vt, sw]) {
      const args = proxyArgs('/in.mp4', '/out.mp4', portrait, attempt)
      expect(valueOf(args, '-colorspace')).toBe('bt709')
      expect(valueOf(args, '-color_primaries')).toBe('bt709')
      expect(valueOf(args, '-color_trc')).toBe('bt709')
      expect(valueOf(args, '-color_range')).toBe('tv')
    }
  })

  it('caps the frame rate, handles landscape and silent sources', () => {
    const args = proxyArgs(
      '/in.mp4',
      '/out.mp4',
      {
        width: 1920,
        height: 1080,
        fps: 60,
        hasAudio: false,
        conversion: { kind: 'none' },
        gpu: null
      },
      sw
    )
    expect(valueOf(args, '-vf')).toBe(
      `fps=fps=30:start_time=0,scale=1280:720:out_range=tv,format=yuv420p,${BT709_TAGS}`
    )
    expect(args).not.toContain('-c:a')
    expect(args.filter((a) => a.startsWith('0:a'))).toEqual([])
  })

  it('tone-maps HDR after downscaling', () => {
    const conversion = {
      kind: 'tonemap',
      transfer: 'arib-std-b67',
      primaries: 'bt2020',
      matrix: 'bt2020'
    } as const
    const args = proxyArgs('/in.mov', '/out.mp4', { ...portrait, conversion }, vt)
    expect(valueOf(args, '-vf')?.split(',')).toEqual([
      'fps=fps=30:start_time=0',
      'scale=720:960:out_range=tv',
      'scale=in_transfer=arib-std-b67:in_primaries=bt2020:in_color_matrix=bt2020:' +
        'out_transfer=bt709:out_primaries=bt709:out_color_matrix=bt709:out_range=tv',
      'format=yuv420p',
      BT709_TAGS
    ])
  })
})

describe('analysisCopyArgs', () => {
  it('gives Gemini 4 fps, mono and no metadata (no location data)', () => {
    const args = analysisCopyArgs('/proxy.mp4', '/analysis.mp4', false)
    expect(args.slice(0, 6)).toEqual([...LOCAL_VIDEO_INPUT, '-i', '/proxy.mp4'])
    expect(valueOf(args, '-map_metadata')).toBe('-1')
    expect(valueOf(args, '-map_chapters')).toBe('-1')
    expect(valueOf(args, '-vf')).toBe('fps=fps=4:start_time=0')
    expect(valueOf(args, '-ac')).toBe('1')
  })
})

describe('makeProxy', () => {
  let dir: string
  const warn = vi.fn()
  const tc = {
    ffmpeg: '/bin/ffmpeg',
    ffprobe: '/bin/ffprobe',
    version: '9',
    encoders: new Set(['libx264', 'h264_videotoolbox']),
    hardwareEncoders: ['h264_videotoolbox'],
    hwDecode: true,
    gpuScaling: false,
    toneMapping: true,
    log: { warn }
  } satisfies Toolchain

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hc-proxy-'))
    runFfmpeg.mockReset()
    warn.mockReset()
    source.color = { matrix: null, transfer: null, primaries: null }
    source.pixFmt = 'yuv420p'
    source.quarterTurn = 0
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const outputOf = (call: unknown[]): string => (call[1] as string[]).at(-1) as string
  const filtersOf = (call: unknown[]): string => valueOf(call[1] as string[], '-vf') ?? ''
  const writeOutput = async (_bin: string, args: string[]): Promise<void> => {
    await writeFile(args.at(-1) as string, 'proxy')
  }

  it('falls back to libx264 when VideoToolbox fails', async () => {
    runFfmpeg
      .mockRejectedValueOnce(
        new MediaError('ffmpeg', 'broken', 'VTCompressionSessionCreate failed')
      )
      .mockImplementationOnce(writeOutput)
    const out = join(dir, 'proxy.mp4')
    const used = await makeProxy(tc, '/in.mp4', out, { durationSec: 12 })

    expect(used).toEqual(sw)
    expect(runFfmpeg).toHaveBeenCalledTimes(2)
    expect(runFfmpeg.mock.calls[0][1]).toContain('h264_videotoolbox')
    expect(runFfmpeg.mock.calls[1][1]).toContain('libx264')
    expect(outputOf(runFfmpeg.mock.calls[0])).toBe(outputOf(runFfmpeg.mock.calls[1]))
    expect(warn).toHaveBeenCalledOnce()
    expect(await readFile(out, 'utf8')).toBe('proxy')
    expect(await readdir(dir)).toEqual(['proxy.mp4'])
  })

  it('gives every attempt a time limit that grows with the video, so a hung ffmpeg ends', async () => {
    runFfmpeg
      .mockRejectedValueOnce(new MediaError('ffmpeg', 'broken', 'ffmpeg timed out'))
      .mockImplementationOnce(writeOutput)
    await makeProxy(tc, '/in.mp4', join(dir, 'proxy.mp4'), { durationSec: 12 })
    expect(runFfmpeg.mock.calls.map((call) => call[2].timeoutMs)).toEqual([360_000, 360_000])
  })

  it('does not fall back after a cancellation and leaves no files', async () => {
    runFfmpeg.mockRejectedValueOnce(new MediaError('cancelled', 'Cancelled.'))
    await expect(
      makeProxy(tc, '/in.mp4', join(dir, 'proxy.mp4'), { durationSec: 12 })
    ).rejects.toMatchObject({
      code: 'cancelled'
    })
    expect(runFfmpeg).toHaveBeenCalledOnce()
    expect(await readdir(dir)).toEqual([])
  })

  it('reports the last error when every attempt fails', async () => {
    runFfmpeg.mockRejectedValue(new MediaError('ffmpeg', 'The preview …', 'boom'))
    await expect(
      makeProxy(tc, '/in.mp4', join(dir, 'proxy.mp4'), { durationSec: 12 })
    ).rejects.toMatchObject({
      code: 'ffmpeg',
      details: 'boom'
    })
    expect(runFfmpeg).toHaveBeenCalledTimes(2)
    expect(await readdir(dir)).toEqual([])
  })

  it('tries GPU scaling first and falls back to the classic VideoToolbox path', async () => {
    runFfmpeg
      .mockRejectedValueOnce(new MediaError('ffmpeg', 'broken', 'scale_vt: unsupported'))
      .mockImplementationOnce(writeOutput)
    const used = await makeProxy({ ...tc, gpuScaling: true }, '/in.mp4', join(dir, 'proxy.mp4'), {
      durationSec: 12
    })
    expect(used).toEqual(vt)
    expect(filtersOf(runFfmpeg.mock.calls[0])).toContain('scale_vt=w=720:h=960,hwdownload')
    expect(runFfmpeg.mock.calls[1][1]).not.toContain('-hwaccel_output_format')
    expect(warn).toHaveBeenCalledWith(
      'proxy: h264_videotoolbox (GPU scaling) failed, retrying with h264_videotoolbox (hardware decoding)',
      'scale_vt: unsupported'
    )
  })

  it('skips GPU scaling for sources it cannot handle (mirrored display matrix)', async () => {
    source.quarterTurn = null
    runFfmpeg.mockImplementationOnce(writeOutput)
    const used = await makeProxy({ ...tc, gpuScaling: true }, '/in.mp4', join(dir, 'proxy.mp4'), {
      durationSec: 12
    })
    expect(used).toEqual(vt)
    expect(runFfmpeg).toHaveBeenCalledOnce()
  })

  it('does not retry when the disk is full or the folder is not writable', async () => {
    for (const details of ['Error writing trailer: No space left on device', 'Permission denied']) {
      runFfmpeg.mockReset()
      warn.mockReset()
      const message = details.includes('space') ? MESSAGES.diskFull : MESSAGES.writeDenied(dir)
      runFfmpeg.mockRejectedValue(new MediaError('ffmpeg', message, details))
      await expect(
        makeProxy({ ...tc, gpuScaling: true }, '/in.mp4', join(dir, 'proxy.mp4'), {
          durationSec: 12
        })
      ).rejects.toMatchObject({ code: 'ffmpeg', message })
      expect(runFfmpeg).toHaveBeenCalledOnce()
      expect(warn).not.toHaveBeenCalled()
      expect(await readdir(dir)).toEqual([])
    }
  })

  it('tone-maps HLG sources when ffmpeg can', async () => {
    source.color = HLG
    runFfmpeg.mockImplementationOnce(writeOutput)
    await makeProxy(tc, '/in.mov', join(dir, 'proxy.mp4'), { durationSec: 12 })
    expect(filtersOf(runFfmpeg.mock.calls[0])).toContain('in_transfer=arib-std-b67')
    expect(warn).not.toHaveBeenCalled()
  })

  it('converts HDR without tone mapping (and warns) when ffmpeg cannot tone-map', async () => {
    source.color = HLG
    runFfmpeg.mockImplementationOnce(writeOutput)
    await makeProxy({ ...tc, toneMapping: false }, '/in.mov', join(dir, 'proxy.mp4'), {
      durationSec: 12
    })
    const filters = filtersOf(runFfmpeg.mock.calls[0])
    expect(filters).not.toContain('transfer')
    expect(filters).toContain('scale=in_color_matrix=bt2020:out_color_matrix=bt709:out_range=tv')
    expect(filters).toContain(BT709_TAGS)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('without tone mapping'), '/in.mov')
  })
})
