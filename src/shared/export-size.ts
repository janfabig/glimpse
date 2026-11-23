// Output frame and rough file size of the reel – one formula for media's render, core's free-space
// check and the frame and size shown in the export step.

import { EXPORT_FIXED } from './presets'
import type { AspectRatio } from './types'

/** nearest even integer, at least 2 (yuv420p needs even dimensions) */
export function evenRound(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2)
}

/**
 * Output frame size of the reel with short side S (the fixed 4K unless media's tests pass a small
 * one): 9:16 → S×16S/9, 4:5 → S×5S/4, 1:1 → S×S, 16:9 → 16S/9×S, 'source' → aspect of `source`
 * with short side S (3:4 while no video is known).
 */
export function outputSize(
  aspect: AspectRatio,
  source: { width: number; height: number } | null,
  s: number = EXPORT_FIXED.shortSide
): { width: number; height: number } {
  switch (aspect) {
    case '9:16':
      return { width: s, height: evenRound((s * 16) / 9) }
    case '4:5':
      return { width: s, height: evenRound((s * 5) / 4) }
    case '1:1':
      return { width: s, height: s }
    case '16:9':
      return { width: evenRound((s * 16) / 9), height: s }
    case 'source': {
      const { width, height } =
        source && source.width > 0 && source.height > 0 ? source : { width: 3, height: 4 }
      // multiply first: 2160 × (962 / 864) would give 2404.99… and round to 2404 instead of 2406
      return width <= height
        ? { width: s, height: evenRound((s * height) / width) }
        : { width: evenRound((s * width) / height), height: s }
    }
  }
}

/** busy handheld night footage needs about this many bits per pixel at media's CRF 17 */
const BITS_PER_PIXEL = 0.2

/** rough, deliberately generous size of the final video in bytes */
export function estimateExportBytes(
  aspect: AspectRatio,
  source: { width: number; height: number } | null,
  durationSec: number
): number {
  const { width, height } = outputSize(aspect, source)
  const videoBits = width * height * EXPORT_FIXED.fps * BITS_PER_PIXEL
  return Math.ceil(((videoBits + 192_000) * Math.max(0, durationSec)) / 8)
}
