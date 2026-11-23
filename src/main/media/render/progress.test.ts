import { describe, expect, it } from 'vitest'
import type { RenderProgress } from '../../contracts'
import { createRenderProgress, RENDER_SHARE } from './progress'

describe('createRenderProgress', () => {
  it('maps clips to 85 % (weighted by duration) and joining to 15 %', () => {
    const events: RenderProgress[] = []
    const progress = createRenderProgress([2, 6, 2], (p) => events.push(p))

    progress.clip(0, 0)
    progress.clip(0, 1)
    progress.clip(1, 0.5)
    progress.clip(2, 1)
    progress.join(0.5)
    progress.join(1)
    progress.finishing()

    expect(events.map((e) => [e.phase, e.clipIndex, Number(e.fraction.toFixed(4))])).toEqual([
      ['rendering', 0, 0],
      ['rendering', 0, 0.17],
      ['rendering', 1, 0.425],
      ['rendering', 2, RENDER_SHARE],
      ['joining', undefined, 0.925],
      ['joining', undefined, 1],
      ['finishing', undefined, 1]
    ])
    expect(events.every((e) => e.clipCount === 3)).toBe(true)
  })

  it('never goes backwards and ignores unknown progress', () => {
    const fractions: number[] = []
    const progress = createRenderProgress([1, 1], (p) => fractions.push(p.fraction))
    progress.clip(1, 0.5)
    progress.clip(0, 0.2) // e.g. clips re-rendered after an encoder fallback
    progress.clip(1, -1)
    expect(fractions.map((f) => f.toFixed(4))).toEqual(['0.6375', '0.6375', '0.6375'])
  })
})
