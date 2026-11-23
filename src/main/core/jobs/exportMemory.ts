// What an export's ffmpeg needs at its peak, and what that allows on this Mac. The numbers are
// peak memory footprints measured with ffmpeg 9 at 2160×3840 (docs/ARCHITECTURE.md §6); they grow
// with the pixels of the frame.

const MIB = 1024 * 1024
/** the frame the numbers below were measured at */
const MEASURED_PIXELS = 2160 * 3840
/** x264 at 4K with its lookahead: one clip render */
const ENCODE_BYTES = 2400 * MIB
/** a crossfade segment also decodes two clips and mixes them in 4:4:4 */
const CROSSFADE_BYTES = 300 * MIB

interface Frame {
  width: number
  height: number
}

const scaleOf = (frame: Frame): number => (frame.width * frame.height) / MEASURED_PIXELS

/** ffmpeg gets half of the Mac's RAM – the rest is for macOS, the app and whatever else is open */
export function memoryBudget(totalMemBytes: number): number {
  return totalMemBytes / 2
}

/**
 * Peak memory of one export. No ffmpeg run opens more than two clips (hard cuts one, a crossfade
 * segment two), so the number of clips does not count.
 */
export function exportMemoryBytes(frame: Frame, crossfade: boolean): number {
  return (ENCODE_BYTES + (crossfade ? CROSSFADE_BYTES : 0)) * scaleOf(frame)
}
