import { DEFAULT_BRIEF } from '@shared/presets'
import { describe, expect, it } from 'vitest'
import { briefHash as mainBriefHash } from '../../../main/core/briefHash'
import { briefHash } from './brief-hash'

describe('briefHash (mirror of main)', () => {
  it('computes the same hash as main', async () => {
    for (const prompt of [DEFAULT_BRIEF.prompt, ' Only drops – äöü\n', '', '\t\n']) {
      const brief = { ...DEFAULT_BRIEF, prompt }
      expect(await briefHash(brief, 'gemini-3.8-flash')).toBe(
        mainBriefHash(brief, 'gemini-3.8-flash')
      )
    }
  })

  it('ignores whitespace around the prompt – Gemini gets the prompt trimmed', async () => {
    const base = await briefHash(DEFAULT_BRIEF, 'm')
    expect(await briefHash({ ...DEFAULT_BRIEF, prompt: `${DEFAULT_BRIEF.prompt}\n` }, 'm')).toBe(
      base
    )
    expect(await briefHash({ ...DEFAULT_BRIEF, prompt: `  ${DEFAULT_BRIEF.prompt} ` }, 'm')).toBe(
      base
    )
    expect(await briefHash({ ...DEFAULT_BRIEF, prompt: `${DEFAULT_BRIEF.prompt}!` }, 'm')).not.toBe(
      base
    )
  })
})
