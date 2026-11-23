import { describe, expect, it } from 'vitest'
import { liveGeminiKey } from './testSupport'

describe('liveGeminiKey (gate of the live Gemini test)', () => {
  it('skips the live test when only the app key fallback GEMINI_API_KEY is set', () => {
    expect(liveGeminiKey({ GEMINI_API_KEY: 'AIza-test' })).toBeNull()
    expect(liveGeminiKey({ GEMINI_API_KEY: 'AIza-test', HC_LIVE_GEMINI: 'true' })).toBeNull()
  })

  it('skips it without a key', () => {
    expect(liveGeminiKey({ HC_LIVE_GEMINI: '1' })).toBeNull()
    expect(liveGeminiKey({ HC_LIVE_GEMINI: '1', GEMINI_API_KEY: '  ' })).toBeNull()
  })

  it('runs it with the explicit opt-in and a key', () => {
    expect(liveGeminiKey({ HC_LIVE_GEMINI: '1', GEMINI_API_KEY: ' AIza-test ' })).toBe('AIza-test')
  })
})
