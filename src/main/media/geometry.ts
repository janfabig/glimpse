import { evenRound, outputSize } from '@shared/export-size'
import type { AspectRatio } from '@shared/types'
import { MediaError } from '../contracts'
import { MESSAGES } from './errors'

export { evenRound }

export interface Size {
  width: number
  height: number
}

/** largest even integer ≤ value, at least 2 */
export function evenFloor(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2)
}

function assertValidSize(size: Size): void {
  if (!(size.width > 0 && size.height > 0 && Number.isFinite(size.width * size.height))) {
    throw new MediaError('invalid', MESSAGES.invalidSize)
  }
}

/**
 * Scales so the short side becomes `maxShortSide` (an even number), keeping the aspect ratio.
 * Never upscales; both dimensions are even.
 */
export function fitShortSide(size: Size, maxShortSide: number): Size {
  assertValidSize(size)
  const short = Math.min(size.width, size.height)
  if (short <= maxShortSide) {
    return { width: evenFloor(size.width), height: evenFloor(size.height) }
  }
  const factor = maxShortSide / short
  return size.width <= size.height
    ? { width: maxShortSide, height: evenRound(size.height * factor) }
    : { width: evenRound(size.width * factor), height: maxShortSide }
}

/** output frame size of the reel (shared/export-size.ts); rejects an unusable 'source' size */
export function targetSize(aspect: AspectRatio, source: Size, shortSide: number): Size {
  if (aspect === 'source') assertValidSize(source)
  return outputSize(aspect, source, shortSide)
}

/** aspect ratios equal within `tolerance` (relative) */
export function sameAspect(a: Size, b: Size, tolerance = 0.01): boolean {
  const ra = a.width / a.height
  const rb = b.width / b.height
  return Math.abs(ra - rb) / rb <= tolerance
}
