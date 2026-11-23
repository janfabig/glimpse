import { describe, expect, it } from 'vitest'
import { DEFAULT_BRIEF, LIMITS, TARGET_DURATION_OPTIONS } from './presets'

describe('default brief', () => {
  it('is a prompt and a target length the length control offers', () => {
    expect(Object.keys(DEFAULT_BRIEF)).toEqual(['prompt', 'targetDurationSec'])
    expect(TARGET_DURATION_OPTIONS).toContain(DEFAULT_BRIEF.targetDurationSec)
  })

  it('starts with one general prompt for concerts, festivals and evenings out', () => {
    for (const phrase of [
      'drops',
      'crowd',
      'light shows',
      'friends',
      "don't cut in the middle of a sentence"
    ]) {
      expect(DEFAULT_BRIEF.prompt, phrase).toContain(phrase)
    }
    // the system instruction avoids strong shaking unless the brief explicitly wants it
    expect(DEFAULT_BRIEF.prompt).toContain('Shaky footage while jumping and dancing is fine.')
  })
})

describe('clip length', () => {
  it('is fixed at 1 to 30 seconds', () => {
    expect(LIMITS.clipSec).toEqual({ min: 1, max: 30 })
  })
})
