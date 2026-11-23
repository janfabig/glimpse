import { BT709_ENCODER_TAGS } from '../color'
import type { Size } from '../geometry'
import type { Toolchain } from '../toolchain'

export interface VideoEncoderSpec {
  /** ffmpeg encoder name */
  name: string
  /** codec, rate control, pixel format and tag options */
  args: string[]
}

type EncoderCaps = Pick<Toolchain, 'encoders' | 'hardwareEncoders'>

/** 8-bit 4:2:0, tagged SDR BT.709 – identical for every intermediate and final encode */
const PIX_FMT = ['-pix_fmt', 'yuv420p', ...BT709_ENCODER_TAGS]

/** VideoToolbox has no CRF mode on all machines; derive a bitrate from bits per pixel. */
export function videoToolboxBitrate(size: Size, fps: number, bitsPerPixel: number): string {
  return `${Math.round((size.width * size.height * fps * bitsPerPixel) / 1000)}k`
}

function x264(preset: string, crf: string): VideoEncoderSpec {
  return {
    name: 'libx264',
    args: ['-c:v', 'libx264', '-preset', preset, '-crf', crf, '-profile:v', 'high', ...PIX_FMT]
  }
}

function videoToolboxH264(size: Size, fps: number, bitsPerPixel: number): VideoEncoderSpec {
  const bitrate = videoToolboxBitrate(size, fps, bitsPerPixel)
  return {
    name: 'h264_videotoolbox',
    args: ['-c:v', 'h264_videotoolbox', '-b:v', bitrate, '-profile:v', 'high', ...PIX_FMT]
  }
}

/** libx264 is missing (an ffmpeg built without GPL parts) and VideoToolbox works */
function needsVideoToolbox(caps: EncoderCaps): boolean {
  return !caps.encoders.has('libx264') && caps.hardwareEncoders.includes('h264_videotoolbox')
}

/** The final video stream: H.264 at high quality – libx264, VideoToolbox only if it is missing. */
export function finalVideoEncoder(size: Size, fps: number, caps: EncoderCaps): VideoEncoderSpec {
  return needsVideoToolbox(caps) ? videoToolboxH264(size, fps, 0.2) : x264('medium', '17')
}

/** Near-lossless intermediates for clips that are re-encoded once more (crossfade). */
export function mezzanineEncoder(size: Size, fps: number, caps: EncoderCaps): VideoEncoderSpec {
  return needsVideoToolbox(caps) ? videoToolboxH264(size, fps, 0.4) : x264('veryfast', '16')
}
