import { describe, expect, it } from 'vitest'
import {
  concatJoinArgs,
  concatList,
  crossfadeSegmentArgs,
  crossfadeSegments,
  escapeConcatPath
} from './join'

describe('escapeConcatPath', () => {
  it('single-quotes paths and escapes embedded quotes', () => {
    expect(escapeConcatPath('/tmp/clip-000.mov')).toBe("'/tmp/clip-000.mov'")
    expect(escapeConcatPath('/Users/Demo User/Glimpse/a.mov')).toBe(
      "'/Users/Demo User/Glimpse/a.mov'"
    )
    expect(escapeConcatPath("/Users/o'brien/it's.mov")).toBe("'/Users/o'\\''brien/it'\\''s.mov'")
    expect(escapeConcatPath('/tmp/a\\b #1 $HOME "x".mov')).toBe('\'/tmp/a\\b #1 $HOME "x".mov\'')
    expect(escapeConcatPath('/tmp/Fête – ünïcødé.mov')).toBe("'/tmp/Fête – ünïcødé.mov'")
  })

  it('rejects line breaks', () => {
    expect(() => escapeConcatPath('/tmp/a\nb.mov')).toThrow('invalid characters')
    expect(() => escapeConcatPath('/tmp/a\rb.mov')).toThrow()
  })
})

describe('concatList', () => {
  it('writes an ffconcat file', () => {
    expect(concatList(['/w/clip-000.mov', "/w/it's.mov"])).toBe(
      "ffconcat version 1.0\nfile '/w/clip-000.mov'\nfile '/w/it'\\''s.mov'\n"
    )
  })
})

describe('crossfadeSegments', () => {
  it('cuts the reel into one segment per clip: the clip without the head the fade before it showed', () => {
    // 2.8 s, 2.0 s, 2.5 s at 30 fps with 0.5 s transitions
    expect(crossfadeSegments([84, 60, 75], 30, 0.5)).toEqual([
      { clip: 0, skipFrames: 0, frames: 84, fadeFrames: 15 },
      { clip: 1, skipFrames: 15, frames: 45, fadeFrames: 15 },
      { clip: 2, skipFrames: 15, frames: 60, fadeFrames: 0 }
    ])
  })

  it('adds up to Σd − (n−1)·T for many equal clips', () => {
    const segments = crossfadeSegments(Array<number>(30).fill(150), 30, 0.4)
    expect(segments.map((s) => s.clip)).toEqual(Array.from({ length: 30 }, (_, i) => i))
    expect(segments.slice(1, -1).every((s) => s.skipFrames === 12 && s.fadeFrames === 12)).toBe(
      true
    )
    expect(segments.reduce((sum, s) => sum + s.frames, 0)).toBe(30 * 150 - 29 * 12)
  })

  it('is the whole clip for a single clip', () => {
    expect(crossfadeSegments([75], 30, 0.4)).toEqual([
      { clip: 0, skipFrames: 0, frames: 75, fadeFrames: 0 }
    ])
  })

  it('fades two clips into each other once', () => {
    expect(crossfadeSegments([150, 90], 30, 0.4)).toEqual([
      { clip: 0, skipFrames: 0, frames: 150, fadeFrames: 12 },
      { clip: 1, skipFrames: 12, frames: 78, fadeFrames: 0 }
    ])
  })

  it('leaves a clip of 1 s six frames of its own between two full transitions', () => {
    expect(crossfadeSegments([150, 30, 150], 30, 0.4)[1]).toEqual({
      clip: 1,
      skipFrames: 12,
      frames: 18,
      fadeFrames: 12
    })
  })

  it('shortens transitions to half of a short neighbour', () => {
    // the clip of 10 frames fades in for 5 and out for 5: nothing of it is shown alone
    const segments = crossfadeSegments([90, 10, 90], 30, 1)
    expect(segments).toEqual([
      { clip: 0, skipFrames: 0, frames: 90, fadeFrames: 5 },
      { clip: 1, skipFrames: 5, frames: 5, fadeFrames: 5 },
      { clip: 2, skipFrames: 5, frames: 85, fadeFrames: 0 }
    ])
    expect(segments.reduce((sum, s) => sum + s.frames, 0)).toBe(180)
  })

  it('cuts hard around a one-frame clip: half of it is no frame (the app has no clip under 0.5 s)', () => {
    expect(crossfadeSegments([30, 1, 30], 30, 0.4)).toEqual([
      { clip: 0, skipFrames: 0, frames: 30, fadeFrames: 0 },
      { clip: 1, skipFrames: 0, frames: 1, fadeFrames: 0 },
      { clip: 2, skipFrames: 0, frames: 30, fadeFrames: 0 }
    ])
  })

  it('aligns transitions to whole frames', () => {
    expect(crossfadeSegments([150, 150], 25, 0.33)[0].fadeFrames).toBe(8)
  })
})

describe('crossfadeSegmentArgs', () => {
  const clips = ['/w/clip-000.mov', '/w/clip-001.mov', '/w/clip-002.mov']
  const [, middle, last] = crossfadeSegments([84, 60, 75], 30, 0.5)
  const encoder = ['-c:v', 'libx264']

  it("opens two clips: the segment's own and the start of the next, one decoder thread each", () => {
    const args = crossfadeSegmentArgs({
      clips,
      segment: middle,
      fps: 30,
      videoEncoderArgs: encoder,
      outPath: '/w/segment-001.mov'
    })
    // prettier-ignore
    expect(args.slice(0, 10)).toEqual([
      '-threads', '1', '-i', '/w/clip-001.mov',
      // only the 0.5 s that fade in are read (+ 0.1 s margin)
      '-threads', '1', '-t', '0.6', '-i', '/w/clip-002.mov'
    ])
    expect(args[10]).toBe('-filter_complex')
    expect(args[11].split(';')).toEqual([
      '[0:v]trim=start_frame=15,setpts=PTS-STARTPTS[v0]',
      '[0:a]atrim=start_sample=24000,asetpts=PTS-STARTPTS[a0]',
      '[1:v]trim=end_frame=15[v1]',
      '[1:a]atrim=end_sample=24000[a1]',
      '[v0][v1]xfade=transition=fade:duration=0.5:offset=1[v]',
      '[a0][a1]acrossfade=ns=24000[a]'
    ])
    // prettier-ignore
    expect(args.slice(12)).toEqual([
      '-map', '[v]', '-map', '[a]', '-c:v', 'libx264',
      '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-map_metadata', '-1', '-map_chapters', '-1',
      '/w/segment-001.mov'
    ])
  })

  it('opens only the last clip for the last segment', () => {
    const args = crossfadeSegmentArgs({
      clips,
      segment: last,
      fps: 30,
      videoEncoderArgs: encoder,
      outPath: '/w/segment-002.mov'
    })
    expect(args.filter((arg) => arg === '-i')).toHaveLength(1)
    expect(args.slice(0, 6)).toEqual([
      '-threads',
      '1',
      '-i',
      '/w/clip-002.mov',
      '-filter_complex',
      '[0:v]trim=start_frame=15,setpts=PTS-STARTPTS[v];' +
        '[0:a]atrim=start_sample=24000,asetpts=PTS-STARTPTS[a]'
    ])
  })
})

describe('join args', () => {
  it('stream-copies video for hard cuts and re-encodes audio', () => {
    const args = concatJoinArgs({
      listPath: '/w/concat.txt',
      normalize: true,
      outPath: '/o.mp4'
    })
    // prettier-ignore
    expect(args).toEqual([
      '-fflags', '+igndts', '-f', 'concat', '-safe', '0', '-i', '/w/concat.txt',
      '-map', '0:v:0', '-map', '0:a:0',
      '-c:v', 'copy',
      '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,asetpts=N/SR/TB',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart',
      '/o.mp4'
    ])
  })

  it('omits loudnorm for a reel without sound (or digital silence)', () => {
    const args = concatJoinArgs({ listPath: '/l', normalize: false, outPath: '/o.mp4' })
    expect(args).not.toContain('-af')
  })
})
