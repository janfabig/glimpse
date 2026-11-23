import type { RemoteFileRef } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { AnalyzerError, type AnalyzeRequest, type AnalyzeStage, type Analyzer } from '../contracts'
import { toAnalyzerError } from './errors'
import { createFakeAnalyzer, FAKE_MODELS } from './fake'
import { MESSAGES } from './messages'
import { apiError, instantSleep } from './testSupport'

const NOW = Date.parse('2026-11-01T12:00:00Z')

interface RequestFixture {
  req: AnalyzeRequest
  stages: [AnalyzeStage, number][]
}

function request(overrides: Partial<AnalyzeRequest> = {}): RequestFixture {
  const stages: [AnalyzeStage, number][] = []
  const req: AnalyzeRequest = {
    apiKey: 'any',
    model: 'gemini-3.8-flash',
    video: {
      proxyPath: '/does/not/exist/proxy.mp4',
      proxyFingerprint: 'fp-1',
      durationSec: 300,
      fileName: 'Festival.mp4',
      recordedAt: null
    },
    brief: { prompt: 'Drops and crowd', targetDurationSec: 60 },
    remoteFile: null,
    onRemoteFile: () => undefined,
    onStage: (stage, progress) => stages.push([stage, progress]),
    ...overrides
  }
  return { req, stages }
}

function fakeAnalyzer(stageMs = 400): { analyzer: Analyzer; delays: number[] } {
  const { sleep, delays } = instantSleep()
  return { analyzer: createFakeAnalyzer({ stageMs, sleep, now: () => NOW }), delays }
}

describe('fake analyzer', () => {
  it('returns deterministic English moments spread over the whole video', async () => {
    const { analyzer } = fakeAnalyzer()
    const first = await analyzer.analyze(request().req)
    const second = await analyzer.analyze(request().req)
    expect(second).toEqual(first)

    expect(first.model).toBe('gemini-3.8-flash')
    expect(first.usage).toEqual({
      promptTokens: 29_700,
      outputTokens: 510,
      thoughtsTokens: 400,
      totalTokens: 30_610
    })
    // one per minute, at most 5
    expect(first.moments).toHaveLength(5)
    expect(first.moments[0].start).toBeLessThan(30)
    expect(first.moments[4].end).toBeGreaterThan(270)
    first.moments.forEach((m, i) => {
      expect(m.end - m.start).toBeCloseTo(5)
      expect(m.title.length).toBeGreaterThan(0)
      expect(m.reason.endsWith('.')).toBe(true)
      expect(m.score).toBeGreaterThanOrEqual(1)
      expect(m.score).toBeLessThanOrEqual(10)
      if (i > 0) expect(m.start).toBeGreaterThanOrEqual(first.moments[i - 1].end)
    })
  })

  it('makes a second pass visible: every reason names the earlier clips and the wish it got', async () => {
    const { analyzer } = fakeAnalyzer()
    const first = await analyzer.analyze(request().req)
    const second = await analyzer.analyze(
      request({
        brief: {
          prompt: 'Drops and crowd\nMore friends, less stage. \n',
          targetDurationSec: 60
        },
        earlierClips: [
          { start: 12, end: 17, title: 'Drop', score: 9, inReel: true },
          { start: 40, end: 45, title: 'Crowd', score: 6, inReel: false }
        ]
      }).req
    )
    const note =
      ' Second pass: saw 2 earlier clips (1 in the highlight video), note: “More friends, less stage.”'
    expect(second.moments).toEqual(first.moments.map((m) => ({ ...m, reason: m.reason + note })))
    // a normal analysis, and a video without earlier clips, say nothing about it
    expect(JSON.stringify(first)).not.toContain('Second pass')
  })

  it('varies with the file name', async () => {
    const { analyzer } = fakeAnalyzer()
    const a = await analyzer.analyze(request().req)
    const { req } = request()
    const b = await analyzer.analyze({ ...req, video: { ...req.video, fileName: 'Concert.mp4' } })
    expect(b.moments.map((m) => m.title)).not.toEqual(a.moments.map((m) => m.title))
  })

  it('finds one moment in a video of up to a minute: the whole video when it is shorter', async () => {
    const { analyzer } = fakeAnalyzer()
    const { req } = request()
    const short = await analyzer.analyze({ ...req, video: { ...req.video, durationSec: 20 } })
    expect(short.moments.map((m) => [m.start, m.end])).toEqual([[7.5, 12.5]])
    const tiny = await analyzer.analyze({ ...req, video: { ...req.video, durationSec: 3 } })
    expect(tiny.moments.map((m) => [m.start, m.end])).toEqual([[0, 3]])
  })

  it('simulates the stages with progress ticks', async () => {
    const { analyzer, delays } = fakeAnalyzer(400)
    const { req, stages } = request()
    await analyzer.analyze(req)
    expect(stages).toEqual([
      ['uploading', 0],
      ['uploading', 0.25],
      ['uploading', 0.5],
      ['uploading', 0.75],
      ['uploading', 1],
      ['processing', -1],
      ['analyzing', -1]
    ])
    expect(delays).toEqual([100, 100, 100, 100, 400, 400])
  })

  it('skips the upload when the kept file can be reused', async () => {
    const { analyzer } = fakeAnalyzer()
    const remoteFile = {
      name: 'files/fake-1',
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/fake-1',
      mimeType: 'video/mp4',
      expiresAt: '2026-11-02T12:00:00Z',
      proxyFingerprint: 'fp-1'
    }
    const { req, stages } = request({ remoteFile })
    const result = await analyzer.analyze(req)
    expect(stages[0]).toEqual(['uploading', 1])
    expect(stages.filter(([stage]) => stage === 'uploading')).toHaveLength(1)
    expect(result.remoteFile).toEqual(remoteFile)
  })

  it('returns its fake upload, which stays for the next analysis', async () => {
    const { analyzer } = fakeAnalyzer()
    const result = await analyzer.analyze(request().req)
    expect(result.remoteFile).toEqual({
      name: expect.stringMatching(/^files\/fake-/),
      uri: expect.stringMatching(
        /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/fake-/
      ),
      mimeType: 'video/mp4',
      expiresAt: '2026-11-03T12:00:00.000Z',
      proxyFingerprint: 'fp-1'
    })
  })

  it("fails with a processing error when the file name contains 'fail'", async () => {
    const { analyzer } = fakeAnalyzer()
    const { req, stages } = request()
    const error = await analyzer
      .analyze({ ...req, video: { ...req.video, fileName: 'Clip-FAIL-03.mp4' } })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AnalyzerError)
    expect((error as AnalyzerError).code).toBe('processing')
    expect((error as AnalyzerError).message).toBe(MESSAGES.fakeProcessing)
    expect(stages.at(-1)).toEqual(['processing', -1])
  })

  describe('failures for E2E and UI states, chosen by the file name', () => {
    async function analyzeFile(
      fileName: string,
      overrides: Partial<AnalyzeRequest> = {}
    ): Promise<{ error: AnalyzerError; stages: [AnalyzeStage, number][]; refs: RemoteFileRef[] }> {
      const { analyzer } = fakeAnalyzer()
      const refs: RemoteFileRef[] = []
      const { req, stages } = request({ onRemoteFile: (ref) => refs.push(ref), ...overrides })
      const error = await analyzer
        .analyze({ ...req, video: { ...req.video, fileName } })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(AnalyzerError)
      return { error: error as AnalyzerError, stages, refs }
    }

    it("'quota' → the daily quota is used up (not retryable, after the upload)", async () => {
      const { error, stages, refs } = await analyzeFile('Tag2-QUOTA.mp4')
      // the same error the real analyzer maps a used-up daily quota to
      const real = toAnalyzerError(apiError(429, { message: 'quota per day exceeded' }), {
        model: 'gemini-3.8-flash'
      })
      expect(error).toMatchObject({ code: 'quota', retryable: false, message: real.message })
      expect(stages.at(-1)).toEqual(['analyzing', -1])
      expect(refs).toHaveLength(1)
    })

    it("'auth' → the key is rejected (before anything is uploaded)", async () => {
      const { error, stages, refs } = await analyzeFile('auth.mp4')
      expect(error).toMatchObject({ code: 'auth', retryable: false, message: MESSAGES.auth })
      expect(stages).toEqual([['uploading', 0]])
      expect(refs).toEqual([])
    })

    it("'safety' → a safety block (not retryable, after the upload)", async () => {
      const { error, refs } = await analyzeFile('Safety-Check.mp4')
      expect(error).toMatchObject({ code: 'safety', retryable: false, message: MESSAGES.safety })
      expect(refs).toHaveLength(1)
    })

    it("'fail' stays a retryable processing error without an ACTIVE upload", async () => {
      const { error, refs } = await analyzeFile('Clip-fail.mp4')
      expect(error).toMatchObject({ code: 'processing', retryable: true })
      expect(refs).toEqual([])
    })

    it('uses the earliest failure when a name matches several', async () => {
      expect((await analyzeFile('auth-quota-fail.mp4')).error.code).toBe('auth')
      expect((await analyzeFile('quota-fail.mp4')).error.code).toBe('processing')
      expect((await analyzeFile('safety-quota.mp4')).error.code).toBe('quota')
    })
  })

  describe('onRemoteFile', () => {
    it('reports the fake upload before the analysis', async () => {
      const { analyzer } = fakeAnalyzer()
      const events: string[] = []
      const refs: RemoteFileRef[] = []
      const { req } = request({
        onStage: (stage) => events.push(stage),
        onRemoteFile: (ref) => {
          events.push('reported')
          refs.push(ref)
        }
      })
      const result = await analyzer.analyze(req)
      expect(refs).toEqual([result.remoteFile])
      expect(refs).toEqual([
        {
          name: expect.stringMatching(/^files\/fake-/),
          uri: expect.stringMatching(
            /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/fake-/
          ),
          mimeType: 'video/mp4',
          expiresAt: '2026-11-03T12:00:00.000Z',
          proxyFingerprint: 'fp-1'
        }
      ])
      expect(events.slice(-3)).toEqual(['processing', 'reported', 'analyzing'])
    })

    it('reports the same ref for the same proxy (deterministic) and the reused file', async () => {
      const { analyzer } = fakeAnalyzer()
      const first: RemoteFileRef[] = []
      const second: RemoteFileRef[] = []
      await analyzer.analyze(request({ onRemoteFile: (ref) => first.push(ref) }).req)
      await analyzer.analyze(request({ onRemoteFile: (ref) => second.push(ref) }).req)
      expect(second).toEqual(first)

      const reused: RemoteFileRef[] = []
      const remoteFile = { ...first[0], name: 'files/fake-kept' }
      await analyzer.analyze(request({ remoteFile, onRemoteFile: (ref) => reused.push(ref) }).req)
      expect(reused).toEqual([remoteFile])
    })

    it('ignores a throwing callback', async () => {
      const { analyzer } = fakeAnalyzer()
      const onRemoteFile = (): void => {
        throw new Error('store gone')
      }
      const result = await analyzer.analyze(request({ onRemoteFile }).req)
      expect(result.moments.length).toBeGreaterThan(0)
    })
  })

  it('honours the abort signal', async () => {
    const analyzer = createFakeAnalyzer({ stageMs: 2_000 })
    const controller = new AbortController()
    const pending = analyzer.analyze(request({ signal: controller.signal }).req)
    setTimeout(() => controller.abort(), 10)
    const error = await pending.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AnalyzerError)
    expect((error as AnalyzerError).code).toBe('cancelled')
  })

  it('finishes quickly with short real delays', async () => {
    const analyzer = createFakeAnalyzer({ stageMs: 8 })
    const started = Date.now()
    const result = await analyzer.analyze(request().req)
    expect(result.moments.length).toBeGreaterThan(0)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('accepts any non-empty key and offers two models', async () => {
    const { analyzer } = fakeAnalyzer()
    expect(await analyzer.testKey('anything')).toEqual({
      ok: true,
      message: 'Connected: 2 models available',
      models: [...FAKE_MODELS]
    })
    expect(await analyzer.testKey('  ')).toEqual({
      ok: false,
      message: 'Enter an API key.'
    })
    const models = await analyzer.listModels('x')
    expect(models.map((m) => m.id)).toEqual(['gemini-3.8-flash', 'gemini-3.5-flash-lite'])
    await expect(analyzer.deleteRemoteFile('x', 'files/fake-1')).resolves.toBeUndefined()
  })
})
