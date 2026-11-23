// Defaults and limits of the project settings.

import type { BriefSettings, ExportSettings } from './types'

export const DEFAULT_BRIEF: BriefSettings = {
  prompt:
    'Make an exciting highlight video from my footage. Look for the strongest music moments ' +
    '(drops, choruses the crowd sings along to), people cheering, dancing or jumping, light ' +
    'shows, pyro and confetti, and moments with my friends: laughing, toasting, dancing and ' +
    "good conversations (don't cut in the middle of a sentence). Leave out walking around, " +
    'queues and scenes where nothing happens or the camera only points at the floor or my ' +
    'phone. Shaky footage while jumping and dancing is fine.',
  targetDurationSec: 60
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  aspect: '9:16',
  fit: 'crop',
  transition: 'cut',
  outputDir: null
}

/**
 * What every export uses – fixed, not a choice. The rest of the fixed set is the only path media
 * has (media/render): H.264 at high quality (libx264 CRF 17), a fade in and out at the very start
 * and end, loudness normalisation.
 */
export const EXPORT_FIXED = {
  /** short side of the frame in pixels (4K) */
  shortSide: 2160,
  fps: 30,
  /** how long two neighbouring clips overlap in a crossfade (seconds) */
  crossfadeSec: 0.4
} as const

/**
 * How many videos Gemini analyses at the same time, over all projects – fixed, not a choice (more
 * runs into the limits of the free quota sooner)
 */
export const ANALYSIS_PARALLEL = 2

/** Options for the target-duration control (seconds; null = "No limit") */
export const TARGET_DURATION_OPTIONS: (number | null)[] = [30, 60, 90, 180, null]

/** Bounds enforced by the UI and by the main process */
export const LIMITS = {
  /** longest prompt (characters) */
  promptMax: 10_000,
  /** every clip Gemini suggests is this long (seconds); it picks the length each moment needs */
  clipSec: { min: 1, max: 30 },
  targetDurationSec: { min: 10, max: 1800 },
  /** shortest moment the user can trim to */
  minMomentSec: 0.5
} as const

/** Video file extensions accepted for import (lower case, without dot) */
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', '3gp']
