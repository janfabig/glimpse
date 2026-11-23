// Every proxy and render intermediate is SDR BT.709 with identical colour tags, whatever the
// source: iPhone clips are often HLG/BT.2020 HDR, older cameras BT.601. HDR is tone-mapped with
// libswscale's colour management (`scale` with in/out_transfer, FFmpeg ≥ 8). Measured on this
// machine it maps HLG reference white (75 % signal) to ≈ 94 % SDR, while VideoToolbox's scale_vt
// lands at ≈ 55 % (visibly too dark), so scale_vt is not used. Without colour management, HDR is
// only matrix-converted and the caller logs a warning.

import type { Size } from './geometry'

/** colour properties of a video stream as ffprobe names them; null = unspecified */
export interface ColorInfo {
  /** `color_space`: the YCbCr matrix, e.g. bt709, smpte170m, bt2020nc */
  matrix: string | null
  /** `color_transfer`, e.g. bt709, arib-std-b67 (HLG), smpte2084 (PQ) */
  transfer: string | null
  /** `color_primaries`, e.g. bt709, bt2020 */
  primaries: string | null
}

/** How decoded frames get to SDR BT.709. */
export type SdrConversion =
  /** already BT.709 (or untagged HD video, which players treat as BT.709) */
  | { kind: 'none' }
  /** SDR with another YCbCr matrix, e.g. BT.601 */
  | { kind: 'matrix'; from: string }
  /** HDR or wide gamut: tone and gamut mapping by libswscale */
  | { kind: 'tonemap'; transfer: string; primaries: string; matrix: string }
  /** HDR, but this ffmpeg cannot tone-map: matrix only (looks flat; callers warn) */
  | { kind: 'untonemapped'; transfer: string; matrix: string }

const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084'])

/** ffprobe matrix names → `scale` filter `in_color_matrix` values */
const SCALE_MATRIX: Record<string, string> = {
  bt709: 'bt709',
  smpte170m: 'bt601',
  bt470bg: 'bt601',
  fcc: 'fcc',
  smpte240m: 'smpte240m',
  bt2020nc: 'bt2020',
  bt2020c: 'bt2020'
}

/** primaries the `scale` filter accepts as in_primaries (same names as ffprobe) */
const SCALE_PRIMARIES = new Set([
  'bt709',
  'bt470m',
  'bt470bg',
  'smpte170m',
  'smpte240m',
  'film',
  'bt2020',
  'smpte428',
  'smpte431',
  'smpte432',
  'jedec-p22',
  'ebu3213'
])

/** transfers the `scale` filter accepts as in_transfer (same names as ffprobe) */
const SCALE_TRANSFERS = new Set([
  'bt709',
  'gamma22',
  'gamma28',
  'smpte170m',
  'smpte240m',
  'linear',
  'iec61966-2-1',
  'iec61966-2-4',
  'bt1361e',
  'bt2020-10',
  'bt2020-12',
  'smpte2084',
  'smpte428',
  'arib-std-b67'
])

/** SD/HD guess for untagged video, as QuickTime and mpv do it */
function isHd(size: Size): boolean {
  return Math.max(size.width, size.height) > 1024 || Math.min(size.width, size.height) > 576
}

/**
 * Picks the conversion for a source with the given colour tags and display size. `canToneMap`:
 * the `scale` filter supports colour management (Toolchain.toneMapping).
 */
export function sdrConversion(color: ColorInfo, size: Size, canToneMap: boolean): SdrConversion {
  // 'auto': a matrix the scale filter has no name for, read from the frame
  const matrix = color.matrix === null ? null : (SCALE_MATRIX[color.matrix] ?? 'auto')
  const { transfer } = color
  if (transfer !== null && HDR_TRANSFERS.has(transfer)) {
    const hdrMatrix = matrix === null || matrix === 'auto' ? 'bt2020' : matrix
    if (!canToneMap) return { kind: 'untonemapped', transfer, matrix: hdrMatrix }
    const primaries =
      color.primaries !== null && SCALE_PRIMARIES.has(color.primaries) ? color.primaries : 'bt2020'
    return { kind: 'tonemap', transfer, primaries, matrix: hdrMatrix }
  }
  if (color.primaries === 'bt2020' && canToneMap) {
    // SDR in the BT.2020 gamut (rare): gamut-map instead of showing desaturated colours
    const sdrTransfer = transfer !== null && SCALE_TRANSFERS.has(transfer) ? transfer : 'bt709'
    return {
      kind: 'tonemap',
      transfer: sdrTransfer,
      primaries: 'bt2020',
      matrix: matrix ?? 'bt2020'
    }
  }
  const from = matrix ?? (isHd(size) ? 'bt709' : 'bt601')
  return from === 'bt709' ? { kind: 'none' } : { kind: 'matrix', from }
}

/**
 * Filters performing the conversion. Insert them after downscaling: the conversion runs at the
 * frame's current size (tone mapping a 4K frame costs ~4× as much as the 1080p one).
 */
export function sdrConversionFilters(conversion: SdrConversion): string[] {
  const out = 'out_color_matrix=bt709:out_range=tv'
  switch (conversion.kind) {
    case 'none':
      return []
    case 'matrix':
      return [`scale=in_color_matrix=${conversion.from}:${out}`]
    case 'tonemap':
      return [
        `scale=in_transfer=${conversion.transfer}:in_primaries=${conversion.primaries}:` +
          `in_color_matrix=${conversion.matrix}:out_transfer=bt709:out_primaries=bt709:${out}`
      ]
    case 'untonemapped':
      return [`scale=in_color_matrix=${conversion.matrix}:${out}`]
  }
}

/**
 * Tags frames as SDR BT.709, limited range. Encoders take the frame tags over their own options,
 * so without this an HLG source would stay tagged HLG.
 */
export const BT709_FRAME_TAGS =
  'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv'

/** the same tags as encoder options (container/VUI), for every video encode */
export const BT709_ENCODER_TAGS: readonly string[] = [
  '-colorspace',
  'bt709',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-color_range',
  'tv'
]

/** human-readable name for logs */
export function describeTransfer(transfer: string): string {
  if (transfer === 'arib-std-b67') return 'HLG'
  if (transfer === 'smpte2084') return 'PQ'
  return transfer
}
