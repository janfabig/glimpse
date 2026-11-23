import type { RenderProgress } from '../../contracts'

/** share of the overall progress spent rendering clips; joining gets the rest */
export const RENDER_SHARE = 0.85

export interface RenderProgressTracker {
  /** progress within clip `index` (0..1, negative = unknown) */
  clip(index: number, fraction: number): void
  join(fraction: number): void
  finishing(): void
}

/**
 * Maps per-step ffmpeg progress to overall render progress: clips ≈ 85 % weighted by duration,
 * joining ≈ 15 %. Never goes backwards (e.g. when an encoder fallback re-renders the clips).
 */
export function createRenderProgress(
  clipDurations: readonly number[],
  onProgress?: (progress: RenderProgress) => void
): RenderProgressTracker {
  const clipCount = clipDurations.length
  const total = clipDurations.reduce((sum, d) => sum + d, 0) || 1
  const starts = clipDurations.map((_, i) => clipDurations.slice(0, i).reduce((s, d) => s + d, 0))
  const clamp = (value: number): number => Math.min(1, Math.max(0, value))
  let last = 0

  const emit = (phase: RenderProgress['phase'], fraction: number, clipIndex?: number): void => {
    last = Math.max(last, clamp(fraction))
    onProgress?.({ phase, clipIndex, clipCount, fraction: last })
  }

  return {
    clip: (index, fraction) =>
      emit(
        'rendering',
        (RENDER_SHARE * (starts[index] + clipDurations[index] * clamp(fraction))) / total,
        index
      ),
    join: (fraction) => emit('joining', RENDER_SHARE + (1 - RENDER_SHARE) * clamp(fraction)),
    finishing: () => emit('finishing', 1)
  }
}
