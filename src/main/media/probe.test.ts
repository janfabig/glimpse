import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MediaError } from '../contracts'
import type { RawProbe, RawStream } from './probe'
import {
  colorInfoOf,
  isLocalTimeCamera,
  parseCreationTime,
  parseDisplayMatrix,
  parseFrameRate,
  parseProbe,
  parseSourceInfo,
  quarterTurnOf,
  rotationOf,
  videoEndOf
} from './probe'

/** pins the machine time zone for local-time readings (restored afterwards) */
function inTimeZone(zone: string): void {
  let saved: string | undefined
  beforeAll(() => {
    saved = process.env.TZ
    process.env.TZ = zone
  })
  afterAll(() => {
    if (saved === undefined) delete process.env.TZ
    else process.env.TZ = saved
  })
}

const matrix = (rotation: number | string): RawStream => ({
  codec_type: 'video',
  side_data_list: [{ side_data_type: 'Display Matrix', rotation }]
})

describe('rotationOf', () => {
  it('converts the counter-clockwise display matrix angle to clockwise degrees', () => {
    expect(rotationOf(matrix(-90))).toBe(90) // iPhone portrait
    expect(rotationOf(matrix(90))).toBe(270)
    expect(rotationOf(matrix(180))).toBe(180)
    expect(rotationOf(matrix(-180))).toBe(180)
    expect(rotationOf(matrix(0))).toBe(0)
    expect(rotationOf(matrix('-90'))).toBe(90)
  })

  it('rounds odd angles to quarter turns', () => {
    expect(rotationOf(matrix(-89.9))).toBe(90)
    expect(rotationOf(matrix(-270))).toBe(270)
  })

  it('falls back to the legacy rotate tag (already clockwise)', () => {
    expect(rotationOf({ tags: { rotate: '90' } })).toBe(90)
    expect(rotationOf({ tags: { rotate: '-90' } })).toBe(270)
    expect(rotationOf({ tags: { ROTATE: '180' } })).toBe(180)
  })

  it('prefers the display matrix over the tag and defaults to 0', () => {
    expect(rotationOf({ ...matrix(-90), tags: { rotate: '180' } })).toBe(90)
    expect(rotationOf({ side_data_list: [{ side_data_type: 'CPB properties' }] })).toBe(0)
    expect(rotationOf({})).toBe(0)
  })
})

describe('quarterTurnOf', () => {
  // ffprobe's displaymatrix text for a 16.16 fixed-point matrix [a b 0; c d 0; 0 0 1<<30]
  const display = (a: number, b: number, c: number, d: number, rotation: number): RawStream => ({
    codec_type: 'video',
    side_data_list: [
      {
        side_data_type: 'Display Matrix',
        rotation,
        displaymatrix:
          `\n00000000: ${a * 65536} ${b * 65536} 0\n00000001: ${c * 65536} ${d * 65536} 0\n` +
          '00000002: 0 0 1073741824\n'
      }
    ]
  })

  it('reads the matrix text', () => {
    expect(parseDisplayMatrix(display(0, 1, -1, 0, -90).side_data_list?.[0].displaymatrix)).toEqual(
      [0, 65536, 0, -65536, 0, 0, 0, 0, 1073741824]
    )
    expect(parseDisplayMatrix('garbage')).toBeNull()
    expect(parseDisplayMatrix(undefined)).toBeNull()
  })

  it('gives the clockwise turn of pure rotations', () => {
    expect(quarterTurnOf(display(0, 1, -1, 0, -90))).toBe(90) // iPhone portrait
    expect(quarterTurnOf(display(0, -1, 1, 0, 90))).toBe(270)
    expect(quarterTurnOf(display(-1, 0, 0, -1, 180))).toBe(180)
    expect(quarterTurnOf(display(1, 0, 0, 1, 0))).toBe(0)
    expect(quarterTurnOf({ codec_type: 'video' })).toBe(0)
    expect(quarterTurnOf({ tags: { rotate: '90' } })).toBe(90)
  })

  it('is null for mirrored, odd-angle or unreadable matrices', () => {
    expect(quarterTurnOf(display(0, 1, 1, 0, -90))).toBeNull() // turned and mirrored
    expect(quarterTurnOf(display(-1, 0, 0, 1, 180))).toBeNull() // mirrored only
    expect(
      quarterTurnOf({
        ...display(1, 0, 0, 1, 0),
        side_data_list: [{ side_data_type: 'Display Matrix', rotation: -45 }]
      })
    ).toBeNull()
    expect(quarterTurnOf({ tags: { rotate: '45' } })).toBeNull()
  })
})

describe('parseFrameRate', () => {
  it('parses rationals and plain numbers', () => {
    expect(parseFrameRate('30000/1001')).toBe(29.97)
    expect(parseFrameRate('30/1')).toBe(30)
    expect(parseFrameRate('25')).toBe(25)
    expect(parseFrameRate('8100/271')).toBe(29.889)
  })

  it('rejects unknown or implausible rates', () => {
    expect(parseFrameRate('0/0')).toBeNull()
    expect(parseFrameRate('90000/1')).toBeNull()
    expect(parseFrameRate('abc')).toBeNull()
    expect(parseFrameRate(undefined)).toBeNull()
  })
})

describe('parseCreationTime', () => {
  it('normalises the common container formats to ISO UTC', () => {
    expect(parseCreationTime('2026-07-12T19:14:05.000000Z')).toBe('2026-07-12T19:14:05.000Z')
    expect(parseCreationTime('2026-07-12T21:14:05+0200')).toBe('2026-07-12T19:14:05.000Z')
    expect(parseCreationTime('2026-07-12T21:14:05+02:00')).toBe('2026-07-12T19:14:05.000Z')
  })

  it('takes the first of ";"-joined duplicates (MOV with metadata tags)', () => {
    expect(parseCreationTime('2026-07-12T19:20:00.000000Z;2026-07-12T19:20:00Z')).toBe(
      '2026-07-12T19:20:00.000Z'
    )
  })

  it('treats zone-less values as UTC (independent of the machine time zone)', () => {
    expect(parseCreationTime('2026-07-12 19:14:05')).toBe('2026-07-12T19:14:05.000Z')
    expect(parseCreationTime('2026-07-12')).toBe('2026-07-12T00:00:00.000Z')
  })

  it('drops placeholder epochs and garbage', () => {
    expect(parseCreationTime('1904-01-01T00:00:00.000000Z')).toBeNull()
    expect(parseCreationTime('1970-01-01T00:00:00.000000Z')).toBeNull()
    expect(parseCreationTime('yesterday')).toBeNull()
    expect(parseCreationTime('')).toBeNull()
    expect(parseCreationTime(undefined)).toBeNull()
    expect(parseCreationTime('1970-01-01T00:00:00Z', 'local')).toBeNull()
    expect(parseCreationTime('yesterday', 'local')).toBeNull()
  })

  describe('local wall-clock time (cameras without zones), on a Mac in Berlin', () => {
    inTimeZone('Europe/Berlin')

    it('reads zone-less and "Z" values as local time of that date (summer and winter)', () => {
      // a GoPro clip recorded at 20:00 CEST: ffprobe shows 20:00 with a "Z"
      expect(parseCreationTime('2026-07-12T20:00:00.000000Z', 'local')).toBe(
        '2026-07-12T18:00:00.000Z'
      )
      expect(parseCreationTime('2026-07-12 20:00:00', 'local')).toBe('2026-07-12T18:00:00.000Z')
      expect(parseCreationTime('2026-01-12T20:00:00.250000Z', 'local')).toBe(
        '2026-01-12T19:00:00.250Z'
      )
      expect(parseCreationTime('2026-07-12', 'local')).toBe('2026-07-11T22:00:00.000Z')
    })

    it('keeps explicit offsets and the UTC default', () => {
      expect(parseCreationTime('2026-07-12T20:00:00+0200', 'local')).toBe(
        '2026-07-12T18:00:00.000Z'
      )
      expect(parseCreationTime('2026-07-12T20:00:00-04:00', 'local')).toBe(
        '2026-07-13T00:00:00.000Z'
      )
      expect(parseCreationTime('2026-07-12T20:00:00.000000Z')).toBe('2026-07-12T20:00:00.000Z')
    })
  })
})

describe('isLocalTimeCamera', () => {
  const withHandler = (handler_name: string): RawProbe => ({
    streams: [{ codec_type: 'video', tags: { handler_name } }]
  })

  it('recognises GoPro and DJI by handler name, firmware or encoder tag', () => {
    expect(isLocalTimeCamera(withHandler('\tGoPro AVC  '))).toBe(true)
    expect(isLocalTimeCamera(withHandler('GoPro H.265'))).toBe(true)
    expect(isLocalTimeCamera(withHandler('DJI.AVC'))).toBe(true)
    expect(isLocalTimeCamera({ format: { tags: { firmware: 'HD9.01.01.60.00' } } })).toBe(true)
    expect(isLocalTimeCamera({ format: { tags: { firmware: 'H22.01.01.20.00' } } })).toBe(true)
    expect(isLocalTimeCamera({ format: { tags: { encoder: 'DJI OsmoAction4' } } })).toBe(true)
  })

  it('leaves phones, Meta glasses and generic writers alone', () => {
    expect(isLocalTimeCamera(withHandler('Core Media Video'))).toBe(false)
    expect(isLocalTimeCamera(withHandler('VideoHandler'))).toBe(false)
    expect(isLocalTimeCamera({ format: { tags: { encoder: 'Lavf61.7.100' } } })).toBe(false)
    expect(isLocalTimeCamera({ format: { tags: { firmware: '1.2.3' } } })).toBe(false)
    expect(isLocalTimeCamera({})).toBe(false)
  })
})

describe('recording time of camera clips (Mac in Berlin)', () => {
  inTimeZone('Europe/Berlin')

  const clip = (formatTags: Record<string, string>, handler = 'VideoHandler'): RawProbe => ({
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1920,
        height: 1080,
        tags: { creation_time: formatTags.creation_time ?? '', handler_name: handler }
      },
      { codec_type: 'audio', codec_name: 'aac', tags: { handler_name: handler } }
    ],
    format: { duration: '10', tags: formatTags }
  })

  it('orders a GoPro clip at 20:00 CEST before a Meta clip at 21:20 CEST', () => {
    const gopro = parseProbe(
      clip({ creation_time: '2026-07-12T20:00:00.000000Z' }, 'GoPro AVC  '),
      1
    )
    expect(gopro.recordedAt).toBe('2026-07-12T18:00:00.000Z')
    const meta = parseProbe(
      clip({
        creation_time: '2026-07-12T19:45:00.000000Z',
        'com.apple.quicktime.creationdate': '2026-07-12T21:20:00+0200'
      }),
      1
    )
    expect(meta.recordedAt).toBe('2026-07-12T19:20:00.000Z')
    expect(Date.parse(gopro.recordedAt ?? '')).toBeLessThan(Date.parse(meta.recordedAt ?? ''))
  })

  it('uses the firmware or encoder tag when the handlers are generic', () => {
    const tags = { creation_time: '2026-07-12T20:00:00.000000Z' }
    expect(parseProbe(clip({ ...tags, firmware: 'H23.01.01.10.00' }), 1).recordedAt).toBe(
      '2026-07-12T18:00:00.000Z'
    )
    expect(parseProbe(clip({ ...tags, encoder: 'DJI Pocket3' }), 1).recordedAt).toBe(
      '2026-07-12T18:00:00.000Z'
    )
    // anything else stays UTC
    expect(parseProbe(clip(tags), 1).recordedAt).toBe('2026-07-12T20:00:00.000Z')
  })

  it('still prefers an Apple capture date with offset', () => {
    const tagged = clip(
      {
        creation_time: '2026-07-12T20:00:00.000000Z',
        'com.apple.quicktime.creationdate': '2026-07-12T21:00:00+0200'
      },
      'GoPro AVC'
    )
    expect(parseProbe(tagged, 1).recordedAt).toBe('2026-07-12T19:00:00.000Z')
  })
})

describe('parseProbe', () => {
  const portrait: RawProbe = {
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1440,
        height: 1920,
        avg_frame_rate: '30/1',
        r_frame_rate: '30/1',
        duration: '20.000000',
        tags: { creation_time: '2026-07-12T19:14:05.000000Z' }
      },
      { codec_type: 'audio', codec_name: 'aac', duration: '20.021333' }
    ],
    format: { duration: '20.021333', size: '18940550' }
  }

  it('maps a regular clip', () => {
    expect(parseProbe(portrait, 1)).toEqual({
      durationSec: 20.021333,
      width: 1440,
      height: 1920,
      fps: 30,
      videoCodec: 'h264',
      hasAudio: true,
      recordedAt: '2026-07-12T19:14:05.000Z',
      sizeBytes: 18940550
    })
  })

  it('swaps the display size for quarter-turn rotations', () => {
    const rotated: RawProbe = {
      streams: [
        { ...matrix(-90), codec_name: 'hevc', width: 1920, height: 1080, avg_frame_rate: '30/1' }
      ],
      format: { duration: '10' }
    }
    expect(parseProbe(rotated, 42)).toMatchObject({
      width: 1080,
      height: 1920,
      hasAudio: false,
      recordedAt: null,
      sizeBytes: 42
    })
  })

  it('prefers the Apple capture date and falls back to r_frame_rate', () => {
    const iphone: RawProbe = {
      streams: [
        {
          codec_type: 'video',
          codec_name: 'hevc',
          width: 1920,
          height: 1080,
          avg_frame_rate: '0/0',
          r_frame_rate: '60/1'
        }
      ],
      format: {
        duration: '5.5',
        tags: {
          creation_time: '2026-07-13T08:00:00.000000Z',
          'com.apple.quicktime.creationdate': '2026-07-12T23:59:00+0200'
        }
      }
    }
    expect(parseProbe(iphone, 1)).toMatchObject({ fps: 60, recordedAt: '2026-07-12T21:59:00.000Z' })
  })

  it('skips cover art and uses stream durations when the container has none', () => {
    const withCover: RawProbe = {
      streams: [
        {
          codec_type: 'video',
          codec_name: 'mjpeg',
          width: 600,
          height: 600,
          disposition: { attached_pic: 1 }
        },
        { codec_type: 'video', codec_name: 'vp9', width: 1280, height: 720, duration: '7.5' }
      ],
      format: {}
    }
    expect(parseProbe(withCover, 1)).toMatchObject({
      videoCodec: 'vp9',
      width: 1280,
      durationSec: 7.5,
      fps: 30
    })
  })

  it('throws user-facing probe errors for unusable files', () => {
    const errorOf = (raw: RawProbe): MediaError => {
      try {
        parseProbe(raw, 1)
      } catch (err) {
        return err as MediaError
      }
      throw new Error('expected parseProbe to throw')
    }
    const audioOnly = errorOf({ streams: [{ codec_type: 'audio' }], format: { duration: '3' } })
    expect(audioOnly).toBeInstanceOf(MediaError)
    expect(audioOnly.code).toBe('probe')
    expect(audioOnly.message).toContain('no video track')
    expect(
      errorOf({ streams: [{ codec_type: 'video', width: 10, height: 10 }] }).message
    ).toContain('length')
    expect(errorOf({ streams: [{ codec_type: 'video' }], format: { duration: '1' } }).code).toBe(
      'probe'
    )
  })
})

describe('colorInfoOf', () => {
  it('reads the colour tags and treats unknown values as unspecified', () => {
    expect(
      colorInfoOf({
        color_space: 'bt2020nc',
        color_transfer: 'arib-std-b67',
        color_primaries: 'bt2020'
      })
    ).toEqual({ matrix: 'bt2020nc', transfer: 'arib-std-b67', primaries: 'bt2020' })
    expect(
      colorInfoOf({ color_space: 'unknown', color_transfer: 'reserved', color_primaries: '' })
    ).toEqual({ matrix: null, transfer: null, primaries: null })
    expect(colorInfoOf({})).toEqual({ matrix: null, transfer: null, primaries: null })
  })
})

describe('videoEndOf', () => {
  it('is the video duration for streams starting with the file', () => {
    expect(videoEndOf({ start_time: '0.000000', duration: '5.000000' }, { start_time: '0' })).toBe(
      5
    )
  })

  it('measures from the file start (the -ss timeline)', () => {
    // video starts 0.3 s after the audio
    expect(videoEndOf({ start_time: '0.300000', duration: '2.700000' }, { start_time: '0' })).toBe(
      3
    )
    // MPEG-TS style offsets: everything starts at 1.4 s
    expect(videoEndOf({ start_time: '1.4', duration: '10' }, { start_time: '1.4' })).toBe(10)
    expect(videoEndOf({ duration: '7.5' }, undefined)).toBe(7.5)
  })

  it('is unknown without a stream duration (e.g. Matroska)', () => {
    expect(videoEndOf({ start_time: '0' }, { start_time: '0', duration: '9' })).toBeNull()
  })
})

describe('parseSourceInfo', () => {
  it('adds colour tags and the video end to the ProbeResult', () => {
    const raw: RawProbe = {
      streams: [
        {
          codec_type: 'video',
          codec_name: 'hevc',
          width: 1920,
          height: 1080,
          avg_frame_rate: '30/1',
          start_time: '0.000000',
          duration: '5.000000',
          color_space: 'bt2020nc',
          color_transfer: 'arib-std-b67',
          color_primaries: 'bt2020',
          side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }]
        },
        { codec_type: 'audio', codec_name: 'aac', start_time: '0.000000', duration: '6.000000' }
      ],
      format: { start_time: '0.000000', duration: '6.000000', size: '100' }
    }
    const info = parseSourceInfo(raw, 1)
    expect(info.probe).toEqual(parseProbe(raw, 1))
    expect(info.probe).toMatchObject({ durationSec: 6, width: 1080, height: 1920 })
    expect(info.color).toEqual({
      matrix: 'bt2020nc',
      transfer: 'arib-std-b67',
      primaries: 'bt2020'
    })
    expect(info.videoEndSec).toBe(5)
    // the contract result carries nothing internal
    expect(Object.keys(parseProbe(raw, 1)).sort()).toEqual(
      [
        'durationSec',
        'fps',
        'hasAudio',
        'height',
        'recordedAt',
        'sizeBytes',
        'videoCodec',
        'width'
      ].sort()
    )
  })
})
