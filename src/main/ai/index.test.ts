import { describe, expect, it, vi } from 'vitest'
import { createAnalyzer, DEFAULT_MODEL, MODEL_CATALOG } from './index'
import { apiError, fakeClient, recordingLogger } from './testSupport'

describe('createAnalyzer', () => {
  it('creates the deterministic fake without touching the network', async () => {
    const analyzer = createAnalyzer({ fake: true, fakeStageMs: 1 })
    expect(await analyzer.testKey('anything')).toMatchObject({ ok: true })
    const result = await analyzer.analyze({
      apiKey: '',
      model: DEFAULT_MODEL,
      video: {
        proxyPath: '/does/not/exist.mp4',
        proxyFingerprint: 'fp',
        durationSec: 60,
        fileName: 'clip.mp4',
        recordedAt: null
      },
      brief: { prompt: '', targetDurationSec: null },
      remoteFile: null,
      onRemoteFile: () => undefined,
      onStage: () => undefined
    })
    expect(result.moments.length).toBeGreaterThan(0)
  })

  it('creates the Gemini analyzer with injected dependencies', async () => {
    const client = fakeClient({
      models: [{ name: 'models/gemini-3.8-flash', supportedActions: ['generateContent'] }],
      deleteFile: () => Promise.reject(apiError(500))
    })
    const logger = recordingLogger()
    const createClient = vi.fn(() => client)
    const analyzer = createAnalyzer({ fake: false, logger, gemini: { createClient } })

    expect((await analyzer.listModels('key')).map((m) => m.id)).toEqual(['gemini-3.8-flash'])
    await analyzer.deleteRemoteFile('key', 'files/x')
    expect(createClient).toHaveBeenCalledWith('key')
    expect(logger.entries.map((e) => e.message)).toEqual(['could not delete the remote file'])
  })

  it('exports the model defaults', () => {
    expect(DEFAULT_MODEL).toBe('gemini-3.8-flash')
    expect(MODEL_CATALOG[0].id).toBe(DEFAULT_MODEL)
  })
})
