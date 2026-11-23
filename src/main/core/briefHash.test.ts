import { createHash, webcrypto } from 'node:crypto'
import { DEFAULT_BRIEF } from '@shared/presets'
import { describe, expect, it } from 'vitest'
import { briefHash, legacyBriefHashes, legacyOptionHashes } from './briefHash'

const sha1 = (value: unknown): string =>
  createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12)

describe('briefHash', () => {
  it('is sha1 over the documented fields in the documented order, 12 hex chars', () => {
    const expected = sha1({ prompt: DEFAULT_BRIEF.prompt, model: 'gemini-3.8-flash' })
    expect(briefHash(DEFAULT_BRIEF, 'gemini-3.8-flash')).toBe(expected)
    expect(expected).toMatch(/^[0-9a-f]{12}$/)
  })

  it('matches the renderer implementation (WebCrypto)', async () => {
    const json = JSON.stringify({ prompt: 'Only drops – äöü', model: 'm' })
    const digest = await webcrypto.subtle.digest('SHA-1', new TextEncoder().encode(json))
    const hex = Buffer.from(digest).toString('hex').slice(0, 12)
    expect(briefHash({ ...DEFAULT_BRIEF, prompt: 'Only drops – äöü' }, 'm')).toBe(hex)
  })

  it('ignores whitespace around the prompt – the request to Gemini is the same', () => {
    const base = briefHash(DEFAULT_BRIEF, 'a')
    expect(briefHash({ ...DEFAULT_BRIEF, prompt: `${DEFAULT_BRIEF.prompt}\n` }, 'a')).toBe(base)
    expect(briefHash({ ...DEFAULT_BRIEF, prompt: ` ${DEFAULT_BRIEF.prompt}  ` }, 'a')).toBe(base)
    expect(briefHash({ ...DEFAULT_BRIEF, prompt: `${DEFAULT_BRIEF.prompt} !` }, 'a')).not.toBe(base)
  })

  it('ignores the target length, but not the model', () => {
    const base = briefHash(DEFAULT_BRIEF, 'a')
    expect(briefHash({ ...DEFAULT_BRIEF, targetDurationSec: null }, 'a')).toBe(base)
    expect(briefHash(DEFAULT_BRIEF, 'b')).not.toBe(base)
  })
})

describe('legacyBriefHashes', () => {
  // a brief as builds with clip-length and quality options stored it
  const stored = {
    prompt: ' Only drops\n',
    presetId: null,
    targetDurationSec: 60,
    minClipSec: 1.5,
    maxClipSec: 6,
    analysisQuality: 'fast'
  }
  const old = (prompt: string): string =>
    sha1({ prompt, minClipSec: 1.5, maxClipSec: 6, analysisQuality: 'fast', model: 'm' })

  it('are what those builds hashed: the removed options too, the prompt trimmed or as typed', () => {
    expect(legacyBriefHashes(stored.prompt, stored, 'm')).toEqual([
      old('Only drops'),
      old(' Only drops\n')
    ])
    expect(legacyBriefHashes(stored.prompt, stored, 'm')).not.toContain(
      briefHash({ prompt: stored.prompt, targetDurationSec: 60 }, 'm')
    )
  })

  it('cover every value the removed options could have had, for this prompt and model only', () => {
    const hashes = legacyOptionHashes(stored.prompt, 'm')
    const other = (prompt: string, model: string, min: number, max: number, q: string): string =>
      sha1({ prompt, minClipSec: min, maxClipSec: max, analysisQuality: q, model })
    expect(hashes).toContain(old('Only drops'))
    expect(hashes).toContain(old(' Only drops\n'))
    expect(hashes).toContain(other('Only drops', 'm', 1, 2, 'balanced'))
    expect(hashes).toContain(other('Only drops', 'm', 30, 60, 'detailed'))
    expect(hashes).toContain(other('Only drops', 'm', 2, 8, 'balanced'))
    expect(hashes).not.toContain(other('Only bass', 'm', 2, 8, 'balanced'))
    expect(hashes).not.toContain(other('Only drops', 'n', 2, 8, 'balanced'))
  })

  it('contain the current hash for a brief stored without those options', () => {
    const brief = { prompt: 'Only drops', targetDurationSec: 60 }
    expect(legacyBriefHashes(brief.prompt, brief, 'm')).toContain(briefHash(brief, 'm'))
  })
})
