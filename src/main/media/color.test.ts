import { describe, expect, it } from 'vitest'
import type { ColorInfo } from './color'
import {
  BT709_ENCODER_TAGS,
  BT709_FRAME_TAGS,
  describeTransfer,
  sdrConversion,
  sdrConversionFilters
} from './color'

const HD = { width: 1440, height: 1920 }
const SD = { width: 640, height: 480 }
const color = (
  matrix: string | null,
  transfer: string | null,
  primaries: string | null
): ColorInfo => ({ matrix, transfer, primaries })

const UNTAGGED = color(null, null, null)
const IPHONE_HLG = color('bt2020nc', 'arib-std-b67', 'bt2020')
const HDR10 = color('bt2020nc', 'smpte2084', 'bt2020')

describe('sdrConversion', () => {
  it('leaves BT.709 and untagged HD video alone', () => {
    expect(sdrConversion(color('bt709', 'bt709', 'bt709'), HD, true)).toEqual({ kind: 'none' })
    expect(sdrConversion(color('bt709', null, null), SD, true)).toEqual({ kind: 'none' })
    expect(sdrConversion(UNTAGGED, HD, true)).toEqual({ kind: 'none' })
    expect(sdrConversion(UNTAGGED, { width: 1280, height: 720 }, false)).toEqual({ kind: 'none' })
  })

  it('converts BT.601 (tagged, or untagged SD video) to the BT.709 matrix', () => {
    const bt601 = { kind: 'matrix', from: 'bt601' }
    expect(sdrConversion(color('smpte170m', 'smpte170m', 'smpte170m'), HD, true)).toEqual(bt601)
    expect(sdrConversion(color('bt470bg', null, null), HD, false)).toEqual(bt601)
    expect(sdrConversion(UNTAGGED, SD, true)).toEqual(bt601)
    expect(sdrConversion(UNTAGGED, { width: 1024, height: 576 }, true)).toEqual(bt601)
    expect(sdrConversion(color('smpte240m', null, null), HD, true)).toEqual({
      kind: 'matrix',
      from: 'smpte240m'
    })
    // a matrix the scale filter has no name for: let it read the frame
    expect(sdrConversion(color('ycgco', null, null), HD, true)).toEqual({
      kind: 'matrix',
      from: 'auto'
    })
  })

  it('tone-maps HLG and PQ when ffmpeg can', () => {
    expect(sdrConversion(IPHONE_HLG, HD, true)).toEqual({
      kind: 'tonemap',
      transfer: 'arib-std-b67',
      primaries: 'bt2020',
      matrix: 'bt2020'
    })
    expect(sdrConversion(HDR10, HD, true)).toMatchObject({ kind: 'tonemap', transfer: 'smpte2084' })
    // HDR with missing matrix/primaries tags: BT.2020 is the only sensible assumption
    expect(sdrConversion(color(null, 'arib-std-b67', null), SD, true)).toEqual({
      kind: 'tonemap',
      transfer: 'arib-std-b67',
      primaries: 'bt2020',
      matrix: 'bt2020'
    })
  })

  it('falls back to a matrix-only conversion of HDR without colour management', () => {
    expect(sdrConversion(IPHONE_HLG, HD, false)).toEqual({
      kind: 'untonemapped',
      transfer: 'arib-std-b67',
      matrix: 'bt2020'
    })
  })

  it('gamut-maps SDR in the BT.2020 gamut when it can', () => {
    expect(sdrConversion(color('bt2020nc', 'bt2020-10', 'bt2020'), HD, true)).toEqual({
      kind: 'tonemap',
      transfer: 'bt2020-10',
      primaries: 'bt2020',
      matrix: 'bt2020'
    })
    expect(sdrConversion(color('bt2020nc', 'log316', 'bt2020'), HD, true)).toMatchObject({
      transfer: 'bt709'
    })
    expect(sdrConversion(color('bt2020nc', 'bt2020-10', 'bt2020'), HD, false)).toEqual({
      kind: 'matrix',
      from: 'bt2020'
    })
  })
})

describe('sdrConversionFilters', () => {
  it('builds one scale filter per conversion (none for BT.709)', () => {
    expect(sdrConversionFilters({ kind: 'none' })).toEqual([])
    expect(sdrConversionFilters({ kind: 'matrix', from: 'bt601' })).toEqual([
      'scale=in_color_matrix=bt601:out_color_matrix=bt709:out_range=tv'
    ])
    expect(
      sdrConversionFilters({
        kind: 'tonemap',
        transfer: 'smpte2084',
        primaries: 'bt2020',
        matrix: 'bt2020'
      })
    ).toEqual([
      'scale=in_transfer=smpte2084:in_primaries=bt2020:in_color_matrix=bt2020:' +
        'out_transfer=bt709:out_primaries=bt709:out_color_matrix=bt709:out_range=tv'
    ])
    expect(
      sdrConversionFilters({ kind: 'untonemapped', transfer: 'arib-std-b67', matrix: 'bt2020' })
    ).toEqual(['scale=in_color_matrix=bt2020:out_color_matrix=bt709:out_range=tv'])
  })

  it('tags frames and streams identically', () => {
    expect(BT709_FRAME_TAGS).toBe(
      'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv'
    )
    expect(BT709_ENCODER_TAGS).toEqual([
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-color_range',
      'tv'
    ])
  })
})

describe('describeTransfer', () => {
  it('names HDR transfers for logs', () => {
    expect(describeTransfer('arib-std-b67')).toBe('HLG')
    expect(describeTransfer('smpte2084')).toBe('PQ')
    expect(describeTransfer('bt709')).toBe('bt709')
  })
})
