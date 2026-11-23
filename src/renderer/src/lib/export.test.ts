import { describe, expect, it } from 'vitest'
import { DEFAULT_EXPORT_SETTINGS } from '@shared/presets'
import type { ExportPhase, ExportProgress, Moment, VideoInfo } from '@shared/types'
import {
  cropWindow,
  estimateRenderSec,
  exportOutdated,
  isExportRunning,
  mismatchedVideos,
  reelSignature
} from './export'

const portrait = { width: 1440, height: 1920 } as VideoInfo
const landscape = { width: 1920, height: 1080 } as VideoInfo

describe('estimateRenderSec', () => {
  it('takes a multiple of the reel length (4K) and grows with crossfades', () => {
    const base = DEFAULT_EXPORT_SETTINGS
    // a minute of 4K in 10 clips: about 3 to 8.5 minutes
    expect(estimateRenderSec(base, 10, 60)).toEqual([192, 508])
    const [low, high] = estimateRenderSec({ ...base, transition: 'crossfade' }, 10, 60)
    expect(low).toBeGreaterThan(192)
    expect(high).toBeGreaterThan(508)
    expect(estimateRenderSec(base, 0, 0)).toEqual([4, 8])
  })
})

describe('reel signature', () => {
  const moment = (id: string, start: number, selected = true): Moment =>
    ({ id, videoId: 'v1', start, end: start + 4, selected }) as Moment

  it('changes with selection, order and trims, not with unselected moments', () => {
    const base = [moment('a', 0), moment('b', 10), moment('x', 20, false)]
    const signature = reelSignature({ moments: base })
    expect(reelSignature({ moments: [...base, moment('y', 30, false)] })).toBe(signature)
    expect(reelSignature({ moments: [base[1], base[0], base[2]] })).not.toBe(signature)
    expect(reelSignature({ moments: [base[0], { ...base[1], end: 15 }, base[2]] })).not.toBe(
      signature
    )
    expect(reelSignature({ moments: [base[0], base[2]] })).not.toBe(signature)
  })
})

describe('exportOutdated', () => {
  const reel = { moments: [{ id: 'a', videoId: 'v1', start: 0, end: 4, selected: true } as Moment] }
  const basis = reelSignature(reel)
  const trimmed = { moments: [{ ...reel.moments[0], end: 3 }] }
  const at = (phase: ExportPhase): ExportProgress => ({
    projectId: 'p1',
    exportId: 'e1',
    phase,
    progress: 0.5
  })

  it('throws a result away once the reel changed, never a running export', () => {
    for (const phase of ['done', 'error', 'cancelled'] as const) {
      expect(isExportRunning(phase)).toBe(false)
      expect(exportOutdated(at(phase), basis, reel)).toBe(false)
      expect(exportOutdated(at(phase), basis, trimmed)).toBe(true)
    }
    for (const phase of ['preparing', 'rendering', 'joining', 'finishing'] as const) {
      expect(isExportRunning(phase)).toBe(true)
      expect(exportOutdated(at(phase), basis, trimmed)).toBe(false)
    }
  })

  it('keeps what it cannot judge: no export, or no reel to compare with', () => {
    expect(exportOutdated(undefined, basis, trimmed)).toBe(false)
    expect(exportOutdated(at('done'), undefined, trimmed)).toBe(false)
  })
})

describe('mismatchedVideos', () => {
  const square = { width: 1080, height: 1080 } as VideoInfo

  it('lists the videos whose shape differs from the output frame', () => {
    expect(mismatchedVideos('9:16', [portrait])).toEqual([portrait])
    expect(mismatchedVideos('source', [portrait])).toEqual([])
    expect(mismatchedVideos('source', [portrait, landscape, square])).toEqual([landscape, square])
    expect(mismatchedVideos('16:9', [portrait, landscape])).toEqual([portrait])
    expect(mismatchedVideos('1:1', [])).toEqual([])
  })

  it('draws the line where the render does: 1 % of the frame’s ratio (main’s sameAspect)', () => {
    // 1.3 % narrower than 9:16 – the render adds a blurred edge
    const nearlyPortrait = { width: 570, height: 1000 } as VideoInfo
    expect(mismatchedVideos('9:16', [nearlyPortrait])).toEqual([nearlyPortrait])
    // 0.7 % wider than 16:9 – the render treats it as the same shape
    const nearlyLandscape = { width: 1790, height: 1000 } as VideoInfo
    expect(mismatchedVideos('16:9', [nearlyLandscape])).toEqual([])
  })
})

describe('cropWindow', () => {
  const crop = DEFAULT_EXPORT_SETTINGS

  it('keeps the centre of the picture that the export frame covers', () => {
    // default 9:16 on the glasses' 3:4: 12.5 % go on each side
    expect(cropWindow(crop, portrait, portrait)).toEqual({ width: 0.75, height: 1 })
    expect(cropWindow({ aspect: '16:9', fit: 'crop' }, portrait, portrait)).toEqual({
      width: 1,
      height: 0.421875
    })
    // 'source' takes the first reel clip's shape, like main
    expect(cropWindow({ aspect: 'source', fit: 'crop' }, portrait, landscape)).toEqual({
      width: 0.421875,
      height: 1
    })
  })

  it('is null when the export cuts nothing', () => {
    expect(cropWindow({ aspect: '9:16', fit: 'blur' }, portrait, portrait)).toBeNull()
    expect(cropWindow({ aspect: 'source', fit: 'crop' }, portrait, portrait)).toBeNull()
    // empty reel: 'source' has no frame yet
    expect(cropWindow({ aspect: 'source', fit: 'crop' }, null, landscape)).toBeNull()
    // within main's 1 % tolerance (sameAspect) the clip is not cropped
    const almost = { width: 1080, height: 1916 } as VideoInfo
    expect(cropWindow(crop, almost, almost)).toBeNull()
    expect(cropWindow(crop, null, { width: 0, height: 0 } as VideoInfo)).toBeNull()
  })
})
