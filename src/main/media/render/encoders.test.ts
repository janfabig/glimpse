import { describe, expect, it } from 'vitest'
import { finalVideoEncoder, mezzanineEncoder, videoToolboxBitrate } from './encoders'

const size = { width: 2160, height: 3840 }
const homebrew = {
  encoders: new Set(['libx264', 'h264_videotoolbox']),
  hardwareEncoders: ['h264_videotoolbox']
}
/** an ffmpeg without the GPL encoders */
const lgpl = { encoders: new Set(['h264_videotoolbox']), hardwareEncoders: ['h264_videotoolbox'] }

const valueOf = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1]

describe('videoToolboxBitrate', () => {
  it('derives kbit/s from bits per pixel', () => {
    expect(videoToolboxBitrate({ width: 1080, height: 1920 }, 30, 0.1)).toBe('6221k')
    expect(videoToolboxBitrate({ width: 720, height: 1280 }, 30, 0.15)).toBe('4147k')
  })
})

describe('finalVideoEncoder', () => {
  it('uses libx264 at high quality', () => {
    const encoder = finalVideoEncoder(size, 30, homebrew)
    expect(encoder.name).toBe('libx264')
    expect(valueOf(encoder.args, '-crf')).toBe('17')
    expect(valueOf(encoder.args, '-preset')).toBe('medium')
    expect(valueOf(encoder.args, '-pix_fmt')).toBe('yuv420p')
  })

  it('falls back to VideoToolbox H.264 only when libx264 is missing', () => {
    const encoder = finalVideoEncoder(size, 30, lgpl)
    expect(encoder.name).toBe('h264_videotoolbox')
    // 0.2 bit per pixel, like the size estimate of the export step
    expect(valueOf(encoder.args, '-b:v')).toBe('49766k')
    // neither encoder: libx264 is named, so ffmpeg's error says what is missing
    const none = { encoders: new Set<string>(), hardwareEncoders: [] }
    expect(finalVideoEncoder(size, 30, none).name).toBe('libx264')
  })
})

describe('mezzanineEncoder', () => {
  it('uses near-lossless fast libx264, VideoToolbox only when libx264 is missing', () => {
    const encoder = mezzanineEncoder(size, 30, homebrew)
    expect(encoder.name).toBe('libx264')
    expect(valueOf(encoder.args, '-crf')).toBe('16')
    expect(valueOf(encoder.args, '-preset')).toBe('veryfast')
    expect(mezzanineEncoder(size, 30, lgpl).name).toBe('h264_videotoolbox')
  })
})

describe('colour tags', () => {
  it('tags every encode SDR BT.709 so intermediates join with identical parameters', () => {
    const all = [homebrew, lgpl].flatMap((caps) => [
      finalVideoEncoder(size, 30, caps),
      mezzanineEncoder(size, 30, caps)
    ])
    expect(all.map((encoder) => encoder.name)).toEqual([
      'libx264',
      'libx264',
      'h264_videotoolbox',
      'h264_videotoolbox'
    ])
    for (const encoder of all) {
      expect(valueOf(encoder.args, '-colorspace'), encoder.name).toBe('bt709')
      expect(valueOf(encoder.args, '-color_primaries'), encoder.name).toBe('bt709')
      expect(valueOf(encoder.args, '-color_trc'), encoder.name).toBe('bt709')
      expect(valueOf(encoder.args, '-color_range'), encoder.name).toBe('tv')
    }
  })
})
