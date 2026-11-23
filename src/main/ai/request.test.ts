import { BlockedReason, FinishReason, MediaModality } from '@google/genai'
import { describe, expect, it } from 'vitest'
import { AnalyzerError } from '../contracts'
import { ContentProblem } from './errors'
import { addUsage, responseText, toTokenUsage, videoTokenCheck } from './request'
import { generateResult } from './testSupport'

function problemKind(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (err) {
    if (err instanceof ContentProblem) return err.kind
    if (err instanceof AnalyzerError) return `analyzer:${err.code}`
    throw err
  }
  return undefined
}

describe('responseText', () => {
  it('returns the answer text without thought parts', () => {
    const result = generateResult('{"moments":[]}', { thought: 'Let me think…' })
    expect(responseText(result)).toBe('{"moments":[]}')
  })

  it.each([[BlockedReason.SAFETY], [BlockedReason.PROHIBITED_CONTENT], [BlockedReason.OTHER]])(
    'treats a blocked prompt (%s) as a safety error',
    (blockReason) => {
      expect(problemKind(() => responseText(generateResult('{}', { blockReason })))).toBe(
        'analyzer:safety'
      )
    }
  )

  it.each([
    [FinishReason.SAFETY],
    [FinishReason.PROHIBITED_CONTENT],
    [FinishReason.BLOCKLIST],
    [FinishReason.SPII]
  ])('treats finishReason %s as a safety error', (finishReason) => {
    const err = (() => {
      try {
        responseText(generateResult('{}', { finishReason }))
      } catch (e) {
        return e
      }
      return null
    })()
    expect(err).toBeInstanceOf(AnalyzerError)
    expect((err as AnalyzerError).code).toBe('safety')
    expect((err as AnalyzerError).message).toBe(
      'Gemini refused to analyse this video for safety reasons.'
    )
  })

  it('reports truncated, stopped and empty answers as content problems', () => {
    expect(
      problemKind(() => responseText(generateResult('{"mom', { finishReason: 'MAX_TOKENS' })))
    ).toBe('truncated')
    expect(
      problemKind(() => responseText(generateResult('{}', { finishReason: 'RECITATION' })))
    ).toBe('stopped')
    expect(
      problemKind(() => responseText(generateResult('{}', { finishReason: 'MALFORMED_RESPONSE' })))
    ).toBe('stopped')
    expect(problemKind(() => responseText(generateResult('   ')))).toBe('empty')
    expect(problemKind(() => responseText({ candidates: [] }))).toBe('empty')
    expect(problemKind(() => responseText({}))).toBe('empty')
  })

  it('accepts STOP and a missing finish reason', () => {
    expect(responseText(generateResult('{}'))).toBe('{}')
    expect(responseText({ candidates: [{ content: { parts: [{ text: '[]' }] } }] })).toBe('[]')
  })
})

describe('videoTokenCheck', () => {
  // 300 s at 1 fps → expected 21 000 frame tokens, floor 8 400
  it('passes when the frames were billed', () => {
    const usage = generateResult('{}', { videoTokens: 21_000 }).usageMetadata
    expect(videoTokenCheck(usage, 300, 1)).toBe('ok')
  })

  it('fails when far too few video tokens were billed', () => {
    const usage = generateResult('{}', { videoTokens: 8_000 }).usageMetadata
    expect(videoTokenCheck(usage, 300, 1)).toBe('too-low')
    expect(
      videoTokenCheck(generateResult('{}', { videoTokens: 9_000 }).usageMetadata, 300, 2)
    ).toBe('too-low')
  })

  it('fails when only text and audio were billed', () => {
    const usage = {
      promptTokenCount: 12_000,
      promptTokensDetails: [
        { modality: MediaModality.TEXT, tokenCount: 4_500 },
        { modality: MediaModality.AUDIO, tokenCount: 7_500 }
      ]
    }
    expect(videoTokenCheck(usage, 300, 1)).toBe('too-low')
  })

  it('counts cached video tokens', () => {
    const usage = {
      promptTokenCount: 22_000,
      promptTokensDetails: [{ modality: MediaModality.TEXT, tokenCount: 1_000 }],
      cacheTokensDetails: [{ modality: MediaModality.VIDEO, tokenCount: 21_000 }]
    }
    expect(videoTokenCheck(usage, 300, 1)).toBe('ok')
  })

  it('falls back to the prompt size without a modality breakdown', () => {
    expect(videoTokenCheck({ promptTokenCount: 30_000 }, 300, 1)).toBe('ok')
    expect(videoTokenCheck({ promptTokenCount: 0 }, 300, 1)).toBe('too-low')
  })

  it('cannot judge responses without usage data', () => {
    expect(videoTokenCheck(undefined, 300, 1)).toBe('unknown')
    expect(videoTokenCheck({}, 300, 1)).toBe('unknown')
  })
})

describe('token usage', () => {
  it('maps usageMetadata to TokenUsage', () => {
    expect(
      toTokenUsage({
        promptTokenCount: 30_000,
        candidatesTokenCount: 400,
        thoughtsTokenCount: 900,
        totalTokenCount: 31_300
      })
    ).toEqual({ promptTokens: 30_000, outputTokens: 400, thoughtsTokens: 900, totalTokens: 31_300 })
  })

  it('fills gaps and computes a missing total', () => {
    expect(toTokenUsage({ promptTokenCount: 10, candidatesTokenCount: 5 })).toEqual({
      promptTokens: 10,
      outputTokens: 5,
      thoughtsTokens: 0,
      totalTokens: 15
    })
    expect(toTokenUsage(undefined)).toBeNull()
  })

  it('adds up several requests', () => {
    const a = { promptTokens: 1, outputTokens: 2, thoughtsTokens: 3, totalTokens: 6 }
    expect(addUsage(a, a)).toEqual({
      promptTokens: 2,
      outputTokens: 4,
      thoughtsTokens: 6,
      totalTokens: 12
    })
    expect(addUsage(null, a)).toBe(a)
    expect(addUsage(a, null)).toBe(a)
    expect(addUsage(null, null)).toBeNull()
  })
})
