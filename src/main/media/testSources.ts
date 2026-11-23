// Small special-purpose sources for edge-case integration tests, generated per test file in a temp
// directory (< 1 s in total): streams that start late or end early, VFR timestamps, a 1 fps
// timelapse, an iPhone-like HLG clip and open-GOP HEVC. The regular test set lives in testVideos.ts.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { FFMPEG } from './testHelpers'

const exec = promisify(execFile)

/** the late-video source: video starts this late; flash (video) and beep (audio) at eventSec */
export const LATE_VIDEO = { offsetSec: 0.3, eventSec: 1 } as const

/** the HLG source: stored landscape, displayed portrait (rotation 90° clockwise) */
export const HLG_SOURCE = { width: 360, height: 640, durationSec: 3 } as const

export interface EdgeSources {
  /** video stream starts LATE_VIDEO.offsetSec after the audio (3 s in total) */
  lateVideo: string
  /** 3 s of video, 4 s of audio */
  shortVideo: string
  /** jittered timestamps: average ≈ 29.8 fps, r_frame_rate 600/1 like iPhone footage (4 s) */
  vfr: string
  /** 10-bit HEVC tagged HLG/BT.2020, flat grey at 75 % signal (HLG reference white) */
  hlg: string
  /** 1 fps timelapse with sound, 4 s: the last frame starts a whole second before the end */
  timelapse: string
}

async function ffmpeg(args: readonly string[]): Promise<void> {
  await exec(FFMPEG, ['-v', 'error', '-nostdin', '-y', ...args])
}

function makeLateVideo(path: string): Promise<void> {
  const { offsetSec, eventSec } = LATE_VIDEO
  const flashFrame = Math.round((eventSec - offsetSec) * 30)
  // prettier-ignore
  return ffmpeg([
    '-itsoffset', String(offsetSec), '-f', 'lavfi', '-i',
    `color=c=black:s=320x180:r=30:d=${3 - offsetSec},format=yuv420p,` +
      `drawbox=c=white:t=fill:enable='eq(n,${flashFrame})'`,
    '-f', 'lavfi', '-i',
    `aevalsrc='0.8*sin(2*PI*1000*t)*between(t,${eventSec},${eventSec + 0.1})':s=48000:d=3`,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-c:a', 'aac', '-b:a', '128k', path
  ])
}

function makeShortVideo(path: string): Promise<void> {
  // prettier-ignore
  return ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3',
    '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000:d=4',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path
  ])
}

function makeVfr(path: string): Promise<void> {
  // frame n at (n + 0.4·(n mod 3)) / 30 s: irregular gaps, still increasing
  // prettier-ignore
  return ffmpeg([
    '-f', 'lavfi', '-i', "testsrc2=s=320x180:r=30:d=4,settb=1/600,setpts='(N+0.4*mod(N\\,3))/30/TB'",
    '-f', 'lavfi', '-i', 'sine=f=330:sample_rate=48000:d=4',
    '-map', '0:v', '-map', '1:a',
    '-fps_mode', 'vfr', '-enc_time_base:v', '1/600', '-video_track_timescale', '600',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path
  ])
}

function makeTimelapse(path: string): Promise<void> {
  // prettier-ignore
  return ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=1:d=4',
    '-f', 'lavfi', '-i', 'sine=f=660:sample_rate=48000:d=4',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path
  ])
}

async function makeHlg(path: string, dir: string): Promise<void> {
  const unrotated = join(dir, 'hlg-unrotated.mov')
  const hlgTags = 'colorspace=bt2020nc:color_primaries=bt2020:color_trc=arib-std-b67:range=tv'
  // prettier-ignore
  await ffmpeg([
    '-f', 'lavfi', '-i',
    // Y = 64 + 0.75 · 876: 75 % HLG signal, where SDR reference white belongs (BT.2408)
    `color=c=black:s=640x360:r=30:d=${HLG_SOURCE.durationSec},format=yuv420p10le,` +
      `geq=lum=721:cb=512:cr=512,setparams=${hlgTags}`,
    '-f', 'lavfi', '-i', `sine=f=550:sample_rate=48000:d=${HLG_SOURCE.durationSec}`,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-tag:v', 'hvc1',
    '-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67',
    '-color_range', 'tv', '-c:a', 'aac', unrotated
  ])
  // display matrix rotation is counter-clockwise: -90 = shown rotated 90° clockwise (portrait)
  await ffmpeg(['-display_rotation:v:0', '-90', '-i', unrotated, '-c', 'copy', path])
}

/**
 * The open-GOP source: HEVC whose keyframes (every 2 s) are CRA pictures with RASL leading
 * pictures, as VideoToolbox writes them with B-frames (iPhone, Meta app exports). The top band
 * shows the frame number n as luma 16 + 4 · (n mod 50), see openGopFrame().
 */
export const OPEN_GOP = {
  width: 640,
  height: 360,
  fps: 30,
  durationSec: 6,
  bandHeight: 64
} as const

/** frame number (mod 50) from the average luma of the open-GOP source's top band */
export function openGopFrame(luma: number): number {
  return Math.round((luma - 16) / 4)
}

export async function makeOpenGopSource(dir: string): Promise<string> {
  const { width, height, fps, durationSec, bandHeight } = OPEN_GOP
  const path = join(dir, 'open-gop.mp4')
  const band = (inside: string, outside: string): string =>
    `if(lt(Y\\,${bandHeight})\\,${inside}\\,${outside})`
  // prettier-ignore
  await ffmpeg([
    '-f', 'lavfi', '-i',
    `testsrc2=s=${width}x${height}:r=${fps}:d=${durationSec},format=yuv420p,` +
      `geq=lum='${band('16+4*mod(N\\,50)', 'lum(X\\,Y)')}':` +
      `cb='${band('128', 'cb(X\\,Y)')}':cr='${band('128', 'cr(X\\,Y)')}'`,
    '-f', 'lavfi', '-i', `sine=f=440:sample_rate=48000:d=${durationSec}`,
    '-map', '0:v', '-map', '1:a',
    // three B-frames before every CRA keyframe are leading pictures (RASL), as with VideoToolbox
    '-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-x265-params',
    `log-level=error:keyint=${2 * fps}:min-keyint=${2 * fps}:scenecut=0:open-gop=1:bframes=3`,
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-c:a', 'aac', path
  ])
  return path
}

export async function makeEdgeSources(dir: string): Promise<EdgeSources> {
  const sources: EdgeSources = {
    lateVideo: join(dir, 'late-video.mp4'),
    shortVideo: join(dir, 'short-video.mp4'),
    vfr: join(dir, 'vfr.mov'),
    hlg: join(dir, 'hlg.mov'),
    timelapse: join(dir, 'timelapse.mp4')
  }
  await Promise.all([
    makeLateVideo(sources.lateVideo),
    makeShortVideo(sources.shortVideo),
    makeVfr(sources.vfr),
    makeHlg(sources.hlg, dir),
    makeTimelapse(sources.timelapse)
  ])
  return sources
}
