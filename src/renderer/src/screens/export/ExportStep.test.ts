import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_EXPORT_SETTINGS } from '@shared/presets'
import type { Project } from '@shared/types'
import { reelSignature } from '../../lib/export'
import type { AppState } from '../../store/app-store'

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('../../api', () => ({ api: () => ({}), initApi: vi.fn() }))
vi.mock('../../store/app-store', () => ({
  useApp: (selector: (state: AppState) => unknown) => selector(store.state as unknown as AppState)
}))

const { ExportStep } = await import('./ExportStep')

const project = {
  id: 'p1',
  videos: [{ id: 'v1', fileName: 'a.mp4', durationSec: 60, width: 1440, height: 1920 }],
  moments: [{ id: 'm1', videoId: 'v1', selected: true, start: 2, end: 6 }],
  exportSettings: DEFAULT_EXPORT_SETTINGS,
  exports: []
} as unknown as Project

describe('ExportStep after a finished export', () => {
  it('names the folder the file went to, not the default folder chosen since then', () => {
    store.state = {
      busy: {},
      // changed in the settings while the result is on screen
      settings: { defaultOutputDir: '/Users/demo/Movies/New' },
      exportBasis: { p1: reelSignature(project) },
      exportProgress: {
        p1: {
          projectId: 'p1',
          exportId: 'e1',
          phase: 'done',
          progress: 1,
          outputPath: '/Users/demo/Movies/Glimpse/Festival.mp4'
        }
      }
    }
    const html = renderToStaticMarkup(createElement(ExportStep, { project }))
    expect(html).toContain('Saved to ~/Movies/Glimpse<')
    expect(html).not.toContain('Saved to ~/Movies/New')
  })
})
