import { describe, expect, it } from 'vitest'
import type { SdrConversion } from '../color'
import type { ClipGraphOptions } from './clip'
import { LOCAL_VIDEO_INPUT } from '../ffargs'
import {
  clipArgs,
  clipFilterGraph,
  clipTiming,
  fadeFrames,
  latestFrameSeek,
  PRE_ROLL_SEC,
  TAIL_HOLD_SEC
} from './clip'

const BT709_TAGS = 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv'
const TONEMAP =
  'scale=in_transfer=arib-std-b67:in_primaries=bt2020:in_color_matrix=bt2020:' +
  'out_transfer=bt709:out_primaries=bt709:out_color_matrix=bt709:out_range=tv'
const hlg: SdrConversion = {
  kind: 'tonemap',
  transfer: 'arib-std-b67',
  primaries: 'bt2020',
  matrix: 'bt2020'
}

describe('clipTiming', () => {
  it('quantises to whole frames and matching sample counts', () => {
    expect(clipTiming(5.3, 8.1, 30)).toMatchObject({
      start: 5.3,
      frames: 84,
      durationSec: 2.8,
      samples: 134400
    })
    expect(clipTiming(0, 2.5, 25)).toMatchObject({
      start: 0,
      frames: 63,
      durationSec: 2.52,
      samples: 120960
    })
    expect(clipTiming(1, 1.25, 60)).toMatchObject({
      start: 1,
      frames: 15,
      durationSec: 0.25,
      samples: 12000
    })
  })

  it('keeps samples exactly in step with frames for every supported fps', () => {
    for (const fps of [25, 30, 60]) {
      for (const [start, end] of [
        [0, 3.333],
        [12.34, 17.01],
        [100, 100.5]
      ]) {
        const t = clipTiming(start, end, fps)
        expect(t.samples / 48000).toBeCloseTo(t.durationSec, 9)
        expect(Number.isInteger(t.samples)).toBe(true)
        expect(Math.abs(t.durationSec - (end - start))).toBeLessThanOrEqual(0.5 / fps + 1e-9)
      }
    }
  })

  it('never produces an empty clip', () => {
    expect(clipTiming(3, 3.001, 30).frames).toBe(1)
  })

  it('pre-rolls half a second before the clip (open-GOP keyframes) and reads a small margin', () => {
    const t = clipTiming(5.3, 8.1, 30, latestFrameSeek(20, 30))
    expect(t).toMatchObject({ leadFrames: 15, leadSamples: 24000, frames: 84, samples: 134400 })
    expect(t.seekSec).toBeCloseTo(5.3 - PRE_ROLL_SEC, 9)
    expect(t.inputSec).toBeCloseTo(0.5 + 2.8 + 0.1, 9)
    expect(clipTiming(5.3, 8.1, 30, null)).toEqual(t)
    // 25 fps: whole frames (13 = 0.52 s), samples follow
    expect(clipTiming(10, 12, 25)).toMatchObject({ leadFrames: 13, leadSamples: 13 * 1920 })
    expect(clipTiming(10, 12, 25).seekSec).toBeCloseTo(10 - 0.52, 9)
  })

  it('pre-rolls less near the file start and never seeks below 0', () => {
    expect(clipTiming(0, 1, 30)).toMatchObject({ seekSec: 0, leadFrames: 0, leadSamples: 0 })
    const early = clipTiming(0.2, 1, 30)
    expect(early).toMatchObject({ leadFrames: 6, leadSamples: 9600 })
    expect(early.seekSec).toBeCloseTo(0, 9)
    // the clip start stays where it was
    const between = clipTiming(0.31, 1, 30)
    expect(between.leadFrames).toBe(9)
    expect(between.seekSec + between.leadFrames / 30).toBeCloseTo(0.31, 9)
  })

  it('decodes from before the end of the video stream when the clip starts there', () => {
    // video ends at 5 s, the audio goes on: 5.2–5.8 has no frame of its own
    const t = clipTiming(5.2, 5.8, 30, latestFrameSeek(5, 30))
    expect(t.leadFrames).toBe(Math.round((5.2 - (5 - TAIL_HOLD_SEC)) * 30))
    expect(t.leadFrames).toBe(21)
    expect(t.seekSec).toBeCloseTo(4.5, 9)
    expect(t.leadSamples).toBe(21 * 1600)
    expect(t.frames).toBe(18)
    expect(t.samples).toBe(18 * 1600)
    expect(t.inputSec).toBeCloseTo(0.7 + 0.6 + 0.1, 9)
    // the clip start stays exactly where it was
    expect(t.seekSec + t.leadFrames / 30).toBeCloseTo(5.2, 9)
  })

  it('also holds the frame for clips starting just before the end and never seeks below 0', () => {
    // 0.4 s after the latest seek: the regular pre-roll already starts before it
    const nearEnd = clipTiming(4.9, 5.5, 30, latestFrameSeek(5, 30))
    expect(nearEnd.leadFrames).toBe(15)
    expect(nearEnd.seekSec).toBeLessThanOrEqual(4.5)
    const earlier = clipTiming(4.4, 5.5, 30, latestFrameSeek(5, 30))
    expect(earlier.leadFrames).toBe(15)
    expect(earlier.seekSec).toBeCloseTo(3.9, 9)
    const tiny = clipTiming(0.3, 0.8, 30, latestFrameSeek(0.2, 30))
    expect(tiny.seekSec).toBeGreaterThanOrEqual(0)
    expect(tiny.seekSec + tiny.leadFrames / 30).toBeCloseTo(0.3, 9)
  })
})

describe('latestFrameSeek', () => {
  it('stays half a second – and at least two source frames – before the end of the video', () => {
    expect(latestFrameSeek(5, 30)).toBe(4.5)
    expect(latestFrameSeek(20, 60)).toBe(19.5)
    // timelapse at 1 fps: the last frame starts a whole second before the end
    expect(latestFrameSeek(10, 1)).toBe(8)
    expect(latestFrameSeek(0.2, 30)).toBe(0)
    expect(latestFrameSeek(null, 30)).toBeNull()
  })
})

describe('fadeFrames', () => {
  it('is 0.5 s, at most half the clip', () => {
    expect(fadeFrames(150, 30)).toBe(15)
    expect(fadeFrames(150, 60)).toBe(30)
    expect(fadeFrames(20, 30)).toBe(10)
    expect(fadeFrames(1, 30)).toBe(1)
  })
})

const base: ClipGraphOptions = {
  target: { width: 720, height: 1280 },
  source: { width: 1440, height: 1920 },
  fps: 30,
  fit: 'crop',
  timing: clipTiming(5.3, 8.1, 30),
  hasAudio: true,
  fadeIn: false,
  fadeOut: false,
  conversion: { kind: 'none' }
}

describe('clipFilterGraph', () => {
  it('crops to fill, tags BT.709 and makes frames/samples exact', () => {
    const [video, audio] = clipFilterGraph(base).split(';')
    // the pre-roll (15 frames) and the input margin are cut off before any per-frame work
    expect(video).toBe(
      '[0:v:0]fps=fps=30:start_time=0,tpad=stop_mode=clone:stop=-1,' +
        'trim=start_frame=15:end_frame=99,setpts=PTS-STARTPTS,' +
        'scale=w=720:h=1280:force_original_aspect_ratio=increase:out_range=tv,' +
        `crop=720:1280,setsar=1,format=yuv420p,${BT709_TAGS}[v]`
    )
    expect(audio).toBe(
      '[0:a:0]aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,' +
        'apad=whole_len=158400,atrim=start_sample=24000:end_sample=158400,asetpts=PTS-STARTPTS[a]'
    )
    // a clip at the file start has no lead to drop
    const [atStart, atStartAudio] = clipFilterGraph({
      ...base,
      timing: clipTiming(0, 2.8, 30)
    }).split(';')
    expect(atStart).toContain('tpad=stop_mode=clone:stop=-1,trim=end_frame=84,setpts=PTS-STARTPTS,')
    expect(atStartAudio).toBe(
      '[0:a:0]aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,' +
        'apad=whole_len=134400,atrim=end_sample=134400[a]'
    )
  })

  it('starts the video at t=0 like the audio (pads a late-starting video stream)', () => {
    expect(clipFilterGraph(base)).toMatch(/^\[0:v:0\]fps=fps=30:start_time=0,/)
    const blur = clipFilterGraph({ ...base, fit: 'blur', source: { width: 1920, height: 1080 } })
    expect(blur).toMatch(/^\[0:v:0\]fps=fps=30:start_time=0,tpad=[^;]*,split=2/)
  })

  it('adds frame- and sample-exact fades on the first/last clip', () => {
    const graph = clipFilterGraph({ ...base, fadeIn: true, fadeOut: true })
    expect(graph).toContain(`${BT709_TAGS},fade=t=in:s=0:n=15,fade=t=out:s=69:n=15[v]`)
    expect(graph).toContain(
      'atrim=start_sample=24000:end_sample=158400,asetpts=PTS-STARTPTS,' +
        'afade=t=in:ss=0:ns=24000,afade=t=out:ss=110400:ns=24000[a]'
    )
    expect(clipFilterGraph({ ...base, fadeOut: true })).not.toContain('t=in')
  })

  it('generates silence for clips without audio', () => {
    const graph = clipFilterGraph({ ...base, hasAudio: false, fadeIn: true })
    expect(graph.split(';').at(-1)).toBe('anullsrc=r=48000:cl=stereo,atrim=end_sample=134400[a]')
    expect(graph).not.toContain('[0:a')
  })

  it('composes a blurred, downscaled background behind the fitted frame', () => {
    // the 4K frame of every export: the background is blurred at 1/8 size (270×480), by 1/36 of
    // the short side (60 px at full size)
    const graph = clipFilterGraph({
      ...base,
      target: { width: 2160, height: 3840 },
      fit: 'blur',
      source: { width: 1920, height: 1080 }
    })
    expect(graph.split(';')).toEqual([
      '[0:v:0]fps=fps=30:start_time=0,tpad=stop_mode=clone:stop=-1,' +
        'trim=start_frame=15:end_frame=99,setpts=PTS-STARTPTS,split=2[bgsrc][fgsrc]',
      '[bgsrc]scale=w=270:h=480:force_original_aspect_ratio=increase:out_range=tv,crop=270:480,' +
        'gblur=sigma=7.5,scale=w=2160:h=3840[bg]',
      '[fgsrc]scale=w=2160:h=3840:force_original_aspect_ratio=decrease:force_divisible_by=2:out_range=tv[fg]',
      '[bg][fg]overlay=x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2,setsar=1,format=yuv420p,' +
        `${BT709_TAGS}[v]`,
      expect.stringContaining('[0:a:0]aresample')
    ])
  })

  it('skips the blur when the source already has the target aspect', () => {
    const graph = clipFilterGraph({ ...base, fit: 'blur', source: { width: 1080, height: 1920 } })
    expect(graph).not.toContain('gblur')
    expect(graph).toContain('crop=720:1280')
  })

  it('converts colours after downscaling, before the 8-bit format and the tags', () => {
    const crop = clipFilterGraph({ ...base, conversion: hlg })
    expect(crop).toContain(`crop=720:1280,${TONEMAP},setsar=1,format=yuv420p,${BT709_TAGS}[v]`)

    // blur: both branches are converted before the (8-bit) overlay
    const blur = clipFilterGraph({
      ...base,
      fit: 'blur',
      source: { width: 1920, height: 1080 },
      conversion: hlg
    }).split(';')
    // 720×1280: the same look in a smaller frame (20 px at full size)
    expect(blur[1]).toContain(`crop=90:160,${TONEMAP},gblur=sigma=2.5`)
    expect(blur[2].endsWith(`force_divisible_by=2:out_range=tv,${TONEMAP}[fg]`)).toBe(true)

    const bt601 = clipFilterGraph({ ...base, conversion: { kind: 'matrix', from: 'bt601' } })
    expect(bt601).toContain(
      'crop=720:1280,scale=in_color_matrix=bt601:out_color_matrix=bt709:out_range=tv,setsar=1'
    )
  })

  it('drops the decoded lead of a clip at the end of the video stream (frames and samples)', () => {
    const timing = clipTiming(5.2, 5.8, 30, latestFrameSeek(5, 30))
    const graph = clipFilterGraph({ ...base, timing, fadeIn: true, fadeOut: true })
    expect(graph).toContain(
      'tpad=stop_mode=clone:stop=-1,trim=start_frame=21:end_frame=39,setpts=PTS-STARTPTS,scale='
    )
    expect(graph).toContain(`${BT709_TAGS},fade=t=in:s=0:n=9,fade=t=out:s=9:n=9[v]`)
    expect(graph).toContain(
      'apad=whole_len=62400,atrim=start_sample=33600:end_sample=62400,asetpts=PTS-STARTPTS,' +
        'afade=t=in:ss=0:ns=14400,afade=t=out:ss=14400:ns=14400[a]'
    )
    // silence needs no lead
    const silent = clipFilterGraph({ ...base, timing, hasAudio: false })
    expect(silent.split(';').at(-1)).toBe('anullsrc=r=48000:cl=stereo,atrim=end_sample=28800[a]')
  })
})

describe('clipArgs', () => {
  it('seeks on the input (with pre-roll), reads a small margin and writes PCM into .mov', () => {
    const args = clipArgs({
      sourcePath: '/videos/a.mp4',
      timing: clipTiming(5.3, 8.1, 30),
      graph: 'GRAPH',
      videoEncoderArgs: ['-c:v', 'libx264'],
      outPath: '/work/clip-000.mov'
    })
    // prettier-ignore
    expect(args).toEqual([
      '-ss', '4.8', '-t', '3.4', ...LOCAL_VIDEO_INPUT, '-i', '/videos/a.mp4',
      '-filter_complex', 'GRAPH', '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264',
      '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2',
      '-map_metadata', '-1', '-map_chapters', '-1',
      '/work/clip-000.mov'
    ])
  })

  it('reads the lead too when the clip starts at the end of the video stream', () => {
    const args = clipArgs({
      sourcePath: '/videos/a.mp4',
      timing: clipTiming(5.2, 5.8, 30, latestFrameSeek(5, 30)),
      graph: 'GRAPH',
      videoEncoderArgs: [],
      outPath: '/work/clip-001.mov'
    })
    expect(args.slice(0, 4)).toEqual(['-ss', '4.5', '-t', '1.4'])
  })
})
