import type { Model } from '@google/genai'
import { describe, expect, it } from 'vitest'
import {
  buildModelOptions,
  DEFAULT_MODEL,
  isAnalysisModel,
  isNewerModel,
  MODEL_CATALOG,
  modelLabel,
  modelVersion,
  requestTimeoutMs
} from './models'

function apiModel(id: string, extra: Partial<Model> = {}): Model {
  return {
    name: `models/${id}`,
    displayName: id.replace(/^gemini-/, 'Gemini ').replace(/-/g, ' '),
    supportedActions: ['generateContent', 'countTokens'],
    ...extra
  }
}

describe('MODEL_CATALOG', () => {
  it('lists the curated models with their labels, recommended first', () => {
    expect(MODEL_CATALOG.map((m) => m.id)).toEqual([
      'gemini-3.8-flash',
      'gemini-4-argon',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite'
    ])
    expect(MODEL_CATALOG[0]).toMatchObject({ id: DEFAULT_MODEL, recommended: true })
    expect(MODEL_CATALOG[0].description).toMatch(/^Recommended/)
    expect(MODEL_CATALOG[1].description).toMatch(/^Best quality: only with billing turned on/)
    expect(MODEL_CATALOG[3].description).toMatch(/^Low cost/)
    expect(MODEL_CATALOG.filter((m) => m.recommended)).toHaveLength(1)
  })

  it('defaults to Gemini 3.8 Flash', () => {
    expect(DEFAULT_MODEL).toBe('gemini-3.8-flash')
  })
})

describe('model traits', () => {
  it('gives Argon and pro-class models 20 minutes', () => {
    expect(requestTimeoutMs('gemini-4-argon')).toBe(20 * 60_000)
    expect(requestTimeoutMs('gemini-5-pro')).toBe(20 * 60_000)
    expect(requestTimeoutMs('gemini-5-pro-preview')).toBe(20 * 60_000)
    expect(requestTimeoutMs('gemini-5.1-argon')).toBe(20 * 60_000)
    expect(requestTimeoutMs('gemini-6-ultra')).toBe(20 * 60_000)
    expect(requestTimeoutMs('gemini-3.8-flash')).toBe(10 * 60_000)
    expect(requestTimeoutMs('gemini-9-flash')).toBe(10 * 60_000)
  })

  it('labels models', () => {
    expect(modelLabel('gemini-3.5-flash-lite')).toBe('Gemini 3.5 Flash-Lite')
    expect(modelLabel('gemini-9-flash')).toBe('gemini-9-flash')
    expect(modelLabel('')).toBeNull()
    expect(modelLabel(undefined)).toBeNull()
  })
})

describe('isAnalysisModel', () => {
  it.each([
    'gemini-3.8-flash',
    'gemini-4-argon',
    'gemini-3.1-flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
    'gemini-5-flash'
  ])('accepts %s', (id) => {
    expect(isAnalysisModel(id)).toBe(true)
  })

  it.each([
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-flash-latest',
    'gemini-3.8-flash-latest',
    'gemini-2.5-flash-preview-tts',
    'gemini-3.5-flash-image-preview',
    'gemini-3.8-flash-live',
    'gemini-live-2.5-flash-preview',
    'gemini-3.8-flash-native-audio-preview',
    'gemini-embedding-001',
    'gemini-3-embedding',
    'gemini-robotics-er-1.5-preview',
    'gemini-3-robotics-er',
    'gemini-2.5-computer-use-preview-10-2025',
    'gemini-3.5-computer-use',
    'gemini-3.5-transcribe',
    'gemini-3.1-pro-preview-customtools',
    'gemma-3-27b-it',
    'imagen-4.0-generate-001'
  ])('rejects %s', (id) => {
    expect(isAnalysisModel(id)).toBe(false)
  })

  it('reads versions', () => {
    expect(modelVersion('gemini-3.8-flash')).toBe(3.8)
    expect(modelVersion('gemini-4-argon')).toBe(4)
    expect(modelVersion('gemini-flash-latest')).toBeNull()
  })
})

describe('isNewerModel', () => {
  it.each(['gemini-3.8-flash-lite', 'gemini-3.9-flash', 'gemini-4-flash', 'gemini-5-pro-preview'])(
    'accepts %s (the default generation or newer)',
    (id) => {
      expect(isNewerModel(id)).toBe(true)
    }
  )

  // legacy (3 Flash preview), paid only (3.1 Pro preview) or superseded by the catalog
  it.each([
    'gemini-3-flash-preview',
    'gemini-3.1-pro-preview',
    'gemini-3.1-flash-lite',
    'gemini-3.7-flash',
    'gemini-flash-latest'
  ])('rejects %s', (id) => {
    expect(isNewerModel(id)).toBe(false)
  })
})

describe('buildModelOptions', () => {
  it('puts the catalog first and adds newer usable models, newest first', () => {
    const options = buildModelOptions([
      apiModel('gemini-2.5-flash'),
      apiModel('gemini-3.5-flash-lite'),
      apiModel('gemini-3.1-flash-lite', { displayName: 'Gemini 3.1 Flash-Lite' }),
      apiModel('gemini-3-flash-preview'),
      apiModel('gemini-3.1-pro-preview'),
      apiModel('gemini-3.8-flash'),
      apiModel('gemini-3.5-flash-image-preview'),
      apiModel('gemini-5-flash-preview', { displayName: 'Gemini 5 Flash Preview' }),
      apiModel('gemini-4.2-flash', { displayName: 'Gemini 4.2 Flash' }),
      apiModel('gemini-embedding-001', { supportedActions: ['embedContent'] }),
      apiModel('gemini-4-argon'),
      apiModel('gemini-3.9-flash', { supportedActions: ['countTokens'] }),
      apiModel('gemini-flash-latest'),
      apiModel('gemini-3.1-pro-preview-customtools')
    ])
    expect(options.map((o) => o.id)).toEqual([
      'gemini-3.8-flash',
      'gemini-4-argon',
      'gemini-3.5-flash-lite',
      'gemini-5-flash-preview',
      'gemini-4.2-flash'
    ])
    expect(options[0]).toEqual(MODEL_CATALOG[0])
    expect(options[3]).toEqual({
      id: 'gemini-5-flash-preview',
      displayName: 'Gemini 5 Flash Preview',
      description: 'New preview model: behaviour and price may change'
    })
    expect(options[4]).toEqual({
      id: 'gemini-4.2-flash',
      displayName: 'Gemini 4.2 Flash',
      description: 'New model from your Gemini account'
    })
  })

  it('says that newer pro-class models usually need billing', () => {
    const options = buildModelOptions([
      apiModel('gemini-5-argon'),
      apiModel('gemini-4.5-pro-preview'),
      apiModel('gemini-6-ultra')
    ])
    expect(options.map((o) => [o.id, o.description])).toEqual([
      ['gemini-6-ultra', 'New top model: usually only with billing turned on'],
      ['gemini-5-argon', 'New top model: usually only with billing turned on'],
      [
        'gemini-4.5-pro-preview',
        'New preview model: usually only with billing turned on, behaviour and price may change'
      ]
    ])
  })

  it('falls back to the id when the API has no display name', () => {
    const options = buildModelOptions([apiModel('gemini-6-flash', { displayName: '  ' })])
    expect(options).toEqual([
      expect.objectContaining({ id: 'gemini-6-flash', displayName: 'gemini-6-flash' })
    ])
  })

  it('offers the catalog when the API lists nothing usable', () => {
    expect(buildModelOptions([])).toEqual(MODEL_CATALOG)
    expect(buildModelOptions([apiModel('gemini-embedding-001')])).toEqual(MODEL_CATALOG)
    expect(
      buildModelOptions([apiModel('gemini-3-flash-preview'), apiModel('gemini-3.1-flash-lite')])
    ).toEqual(MODEL_CATALOG)
  })

  it('returns copies, never the catalog objects themselves', () => {
    const [first] = buildModelOptions([apiModel('gemini-3.8-flash')])
    expect(first).not.toBe(MODEL_CATALOG[0])
  })
})
