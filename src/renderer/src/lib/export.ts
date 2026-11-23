// Export presentation helpers: formats, crop preview, render time and which videos the fit changes.
// Frame and file size: src/shared/export-size.ts.

import type {
  AspectRatio,
  ExportPhase,
  ExportProgress,
  ExportSettings,
  Project,
  VideoInfo
} from '@shared/types'

export interface AspectOption {
  value: AspectRatio
  label: string
  hint: string
}

export const ASPECT_OPTIONS: AspectOption[] = [
  { value: '9:16', label: '9:16', hint: 'Reels, TikTok, Shorts' },
  { value: '4:5', label: '4:5', hint: 'Instagram feed' },
  { value: '1:1', label: '1:1', hint: 'Square' },
  { value: '16:9', label: '16:9', hint: 'YouTube, TV' },
  { value: 'source', label: 'Original', hint: 'As recorded' }
]

/** width/height ratio of a format; `source` uses the first clip's video */
export function aspectRatioOf(aspect: AspectRatio, source: VideoInfo | null): number {
  switch (aspect) {
    case '9:16':
      return 9 / 16
    case '4:5':
      return 4 / 5
    case '1:1':
      return 1
    case '16:9':
      return 16 / 9
    case 'source':
      return source && source.height > 0 ? source.width / source.height : 3 / 4
  }
}

/** the render's test for "same shape" (main's sameAspect): within 1 % of the frame's ratio */
function sameShape(own: number, frame: number): boolean {
  return Math.abs(own - frame) / frame <= 0.01
}

/**
 * Centred part of `video` that the export keeps with "Crop", as fractions of its width and
 * height; null when nothing is cut (other fit, or the same shape within main's 1 % sameAspect).
 * `source` takes the first reel clip's shape, like main; with an empty reel nothing is cut.
 */
export function cropWindow(
  settings: Pick<ExportSettings, 'aspect' | 'fit'>,
  firstVideo: VideoInfo | null,
  video: VideoInfo
): { width: number; height: number } | null {
  if (settings.fit !== 'crop' || !(video.height > 0)) return null
  const frame = aspectRatioOf(settings.aspect, firstVideo ?? video)
  const own = video.width / video.height
  if (sameShape(own, frame)) return null
  return frame < own ? { width: frame / own, height: 1 } : { width: 1, height: own / frame }
}

/**
 * [low, high] seconds for rendering on Apple Silicon – deliberately generous. Encoding 4K takes 3 to
 * 8 times the length of the reel; a crossfade encodes everything twice (fast clips, then the reel).
 */
export function estimateRenderSec(
  settings: Pick<ExportSettings, 'transition'>,
  clipCount: number,
  durationSec: number
): [number, number] {
  const crossfade = settings.transition === 'crossfade'
  return [
    4 + clipCount * 0.8 + durationSec * (crossfade ? 4.5 : 3),
    8 + clipCount * 2 + durationSec * (crossfade ? 12 : 8)
  ]
}

/**
 * Identifies what an export renders: the selected clips in order with their in/out points.
 * A finished export no longer describes the reel once this changes.
 */
export function reelSignature(project: Pick<Project, 'moments'>): string {
  return project.moments
    .filter((m) => m.selected)
    .map((m) => `${m.id}@${m.start}-${m.end}`)
    .join('|')
}

const RUNNING_PHASES: readonly ExportPhase[] = ['preparing', 'rendering', 'joining', 'finishing']

export function isExportRunning(phase: ExportPhase): boolean {
  return RUNNING_PHASES.includes(phase)
}

/**
 * An export that ended (done, failed, cancelled) no longer describes the reel once clips, order or
 * trims differ from `basis`, the reel signature of its start. A running export is never outdated.
 */
export function exportOutdated(
  progress: ExportProgress | undefined,
  basis: string | undefined,
  project: Pick<Project, 'moments'>
): boolean {
  return (
    !!progress &&
    !isExportRunning(progress.phase) &&
    basis !== undefined &&
    basis !== reelSignature(project)
  )
}

/**
 * Videos of the reel whose shape differs from the output frame – only for them the fit setting
 * (crop / blurred background) matters. `source` takes the first clip's shape, like main does.
 */
export function mismatchedVideos(
  aspect: AspectRatio,
  reelVideos: readonly VideoInfo[]
): VideoInfo[] {
  const ratio = aspectRatioOf(aspect, reelVideos[0] ?? null)
  return reelVideos.filter(
    (video) => video.height > 0 && !sameShape(video.width / video.height, ratio)
  )
}
