import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/types'

vi.mock('../../api', () => ({ api: () => ({}), initApi: vi.fn() }))

const { AnalysisStep } = await import('./AnalysisStep')

/** three videos, all analysed; `moments` is what Gemini found */
function analysed(moments: unknown[]): Project {
  const ids = ['a', 'b', 'c']
  return {
    id: 'p1',
    brief: { prompt: 'Show the stage', targetDurationSec: 60 },
    videos: ids.map((id) => ({ id, fileName: `${id}.mp4`, durationSec: 60 })),
    status: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          prepare: { status: 'done', progress: 1 },
          analysis: { stage: 'done', progress: 1, message: 'No matching moments found' }
        }
      ])
    ),
    analyses: Object.fromEntries(ids.map((id) => [id, { videoId: id, briefHash: 'now' }])),
    moments,
    reelEdited: false,
    exports: []
  } as unknown as Project
}

const render = (project: Project): string =>
  renderToStaticMarkup(createElement(AnalysisStep, { project }))

describe('AnalysisStep after a run', () => {
  it('sends the user back to the Prompt step when Gemini found nothing in any video', () => {
    const html = render(analysed([]))
    expect(html).not.toContain('Done!')
    expect(html).not.toContain('In the Edit step you choose')
    expect(html).not.toContain('As soon as moments are found')
    expect(html).toContain('Gemini found no matching moments')
    expect(html).toContain('data-testid="nothing-found-go-brief"')
  })

  it('does not offer the Edit step with 0 moments when another video failed', () => {
    const project = analysed([])
    project.status.c.analysis = { stage: 'error', progress: 0, error: 'Daily quota used up.' }
    const html = render(project)
    expect(html).toContain('1 video failed')
    expect(html).not.toContain('you can already go to the Edit step')
    expect(html).toContain('Gemini found no matching moments there')
  })

  it('still announces the moments Gemini found', () => {
    const html = render(analysed([{ id: 'm1', videoId: 'a', selected: false, start: 1, end: 6 }]))
    expect(html).toContain('Done! 1 moment found in 3 videos')
    expect(html).not.toContain('nothing-found-go-brief')
  })
})
