import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_BRIEF, LIMITS } from '@shared/presets'
import type { Project } from '@shared/types'

vi.mock('../../api', () => ({ api: () => ({}), initApi: vi.fn() }))

const { BriefStep } = await import('./BriefStep')

const project = {
  id: 'p1',
  brief: DEFAULT_BRIEF,
  videos: [{ id: 'a', fileName: 'a.mp4', durationSec: 60 }],
  status: {},
  analyses: {},
  moments: [],
  reelEdited: false
} as unknown as Project

describe('BriefStep', () => {
  it('stops the prompt at the length main keeps, so nothing typed is cut away later', () => {
    const html = renderToStaticMarkup(createElement(BriefStep, { project }))
    const textarea = /<textarea[^>]*>/.exec(html)?.[0] ?? ''
    expect(textarea).toContain('data-testid="brief-prompt"')
    expect(textarea).toContain(`maxLength="${LIMITS.promptMax}"`)
  })

  it('says so when the prompt is full', () => {
    const render = (prompt: string): string =>
      renderToStaticMarkup(
        createElement(BriefStep, { project: { ...project, brief: { ...DEFAULT_BRIEF, prompt } } })
      )
    expect(render('a'.repeat(LIMITS.promptMax))).toContain('10000 characters, the maximum')
    expect(render('a'.repeat(LIMITS.promptMax - 1))).toContain('>9999 characters<')
  })
})
