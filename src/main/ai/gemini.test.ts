import { FileState, type File as GeminiFile, type GenerateContentParameters } from '@google/genai'
import type { RemoteFileRef } from '@shared/types'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest'
import {
  AnalyzerError,
  type AnalyzeRequest,
  type AnalyzeResponse,
  type AnalyzeStage,
  type Analyzer
} from '../contracts'
import { createGeminiAnalyzer, type GeminiDeps } from './gemini'
import { MESSAGES } from './messages'
import {
  abortError,
  activeFile,
  apiError,
  fakeClient,
  generateResult,
  instantSleep,
  networkError,
  recordingLogger,
  sentShare,
  sessionCount,
  tempFile,
  UPLOAD_BASE,
  uploadServer,
  validPayload,
  type FakeClient,
  type FakeClientOptions,
  type TempFile,
  type UploadServer,
  type UploadServerOptions
} from './testSupport'
import { CHUNK_GRANULARITY } from './upload'

const NOW = Date.parse('2026-11-01T12:00:00Z')
const UPLOADED_URI = 'https://generativelanguage.googleapis.com/v1beta/files/abc123'
let proxy: TempFile

beforeAll(async () => {
  proxy = await tempFile(2 * CHUNK_GRANULARITY)
})

afterAll(async () => {
  await proxy.remove()
})

afterEach(() => {
  vi.useRealTimers()
})

interface SetupOptions {
  client?: FakeClientOptions
  server?: UploadServerOptions
  deps?: Partial<GeminiDeps>
}

interface Setup {
  analyzer: Analyzer
  client: FakeClient
  server: UploadServer
  clock: { now: number }
  delays: number[]
  logger: ReturnType<typeof recordingLogger>
  createClient: Mock<() => FakeClient>
}

function setup(options: SetupOptions = {}): Setup {
  const client = fakeClient(options.client)
  const clock = { now: NOW }
  const server = uploadServer({ now: () => clock.now, ...options.server })
  const { sleep, delays } = instantSleep(clock)
  const logger = recordingLogger()
  const createClient = vi.fn(() => client)
  const analyzer = createGeminiAnalyzer({
    createClient,
    fetch: server.fetch,
    sleep,
    now: () => clock.now,
    random: () => 0.5,
    logger,
    uploadBaseUrl: UPLOAD_BASE,
    chunkSize: CHUNK_GRANULARITY,
    timeZone: 'Europe/Berlin',
    ...options.deps
  })
  return { analyzer, client, server, clock, delays, logger, createClient }
}

interface RequestFixture {
  req: AnalyzeRequest
  stages: [AnalyzeStage, number][]
}

function request(overrides: Partial<AnalyzeRequest> = {}): RequestFixture {
  const stages: [AnalyzeStage, number][] = []
  const req: AnalyzeRequest = {
    apiKey: ' key-1 ',
    model: 'gemini-3.8-flash',
    video: {
      proxyPath: proxy.path,
      proxyFingerprint: 'fp-1',
      durationSec: 60,
      fileName: 'Festival.mp4',
      recordedAt: '2026-07-12T21:41:00.000Z'
    },
    brief: { prompt: 'Show me the drops.', targetDurationSec: 60 },
    remoteFile: null,
    onRemoteFile: () => undefined,
    onStage: (stage, progress) => stages.push([stage, progress]),
    ...overrides
  }
  return { req, stages }
}

function promptOf(params: GenerateContentParameters): string {
  const contents = params.contents as { parts: { text?: string }[] }[]
  return contents[0].parts[1].text ?? ''
}

function fileUriOf(params: GenerateContentParameters): string | undefined {
  const contents = params.contents as { parts: { fileData?: { fileUri?: string } }[] }[]
  return contents[0].parts[0].fileData?.fileUri
}

async function failure(promise: Promise<unknown>): Promise<AnalyzerError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(AnalyzerError)
  return error as AnalyzerError
}

const processingThenActive: FakeClientOptions['getFile'] = (name, call) =>
  call < 2 ? activeFile({ name, state: FileState.PROCESSING }) : activeFile({ name })

/** what Gemini answers when a referenced file expired, was deleted or belongs to another key */
const fileGone = (): Error =>
  apiError(403, {
    message: 'You do not have permission to access the File abc123 or it may not exist.',
    status: 'PERMISSION_DENIED'
  })

describe('analyze', () => {
  it('uploads, waits for processing, asks Gemini and cleans up', async () => {
    const { analyzer, client, server, delays } = setup({
      client: { getFile: processingThenActive }
    })
    const { req, stages } = request()

    const result = await analyzer.analyze(req)

    expect(result).toEqual({
      // whole-second end stamps (1 fps) get a short lead-out
      moments: [
        {
          start: 5,
          end: 10.8,
          title: 'Drop with light show',
          reason: 'The drop hits.',
          score: 9
        }
      ],
      model: 'gemini-3.8-flash',
      usage: { promptTokens: 51_500, outputTokens: 400, thoughtsTokens: 900, totalTokens: 52_800 },
      // the upload stays on Google's side for the next analysis
      remoteFile: {
        name: 'files/abc123',
        uri: UPLOADED_URI,
        mimeType: 'video/mp4',
        expiresAt: '2026-11-03T12:00:00Z',
        proxyFingerprint: 'fp-1'
      }
    })
    expect(stages).toEqual([
      ['uploading', 0],
      ['uploading', 0.5],
      ['uploading', 1],
      ['processing', -1],
      ['analyzing', -1]
    ])
    expect(server.received().equals(proxy.content)).toBe(true)
    expect(server.requests[0].headers['x-goog-api-key']).toBe('key-1')
    expect(JSON.parse(server.requests[0].body ?? '').file.displayName).toBe('Festival.mp4')
    expect(client.calls.get).toEqual(['files/abc123', 'files/abc123'])
    expect(delays).toEqual([2_000, 2_000])

    expect(client.calls.generate).toHaveLength(1)
    const params = client.calls.generate[0]
    expect(params.model).toBe('gemini-3.8-flash')
    expect(fileUriOf(params)).toBe(UPLOADED_URI)
    expect(params.config?.store).toBe(false)
    expect(promptOf(params)).toContain('Recorded: Sunday, 12 July 2026 at 23:41')
    expect(client.calls.delete).toEqual([])
  })

  it('sends the earlier clips of a second pass ("Ask Gemini again") to Gemini', async () => {
    const { analyzer, client } = setup()
    const earlierClips = [{ start: 5, end: 9, title: 'Confetti', score: 7, inReel: true }]

    await analyzer.analyze(request({ earlierClips }).req)
    await analyzer.analyze(request().req)

    const [again, normal] = client.calls.generate.map(promptOf)
    expect(again).toContain(
      '<earlier>\n00:05–00:09 | score 7 | in the highlight video | “Confetti”'
    )
    expect(normal).not.toContain('<earlier>')
  })

  it('falls back to the default model and passes a per-call abort signal', async () => {
    const { analyzer, client } = setup()
    const controller = new AbortController()
    const result = await analyzer.analyze(request({ model: '  ', signal: controller.signal }).req)
    expect(result.model).toBe('gemini-3.8-flash')
    const signal = client.calls.generate[0].config?.abortSignal
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal).not.toBe(controller.signal)
  })

  describe('remote file reuse', () => {
    const kept: RemoteFileRef = {
      name: 'files/kept',
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/kept',
      mimeType: 'video/mp4',
      expiresAt: '2026-11-02T12:00:00Z',
      proxyFingerprint: 'fp-1'
    }

    it('skips the upload when the kept file is still active', async () => {
      const { analyzer, client, server } = setup({
        client: {
          getFile: (name) =>
            activeFile({ name, uri: kept.uri, expirationTime: kept.expiresAt ?? undefined })
        }
      })
      const { req, stages } = request({ remoteFile: kept })
      const result = await analyzer.analyze(req)
      expect(server.requests).toHaveLength(0)
      expect(client.calls.get).toEqual(['files/kept'])
      expect(fileUriOf(client.calls.generate[0])).toBe(kept.uri)
      expect(stages).toEqual([
        ['uploading', 0],
        ['analyzing', -1]
      ])
      expect(result.remoteFile).toEqual(kept)
    })

    it.each<[string, Partial<RemoteFileRef>, FakeClientOptions['getFile'], number]>([
      ['the proxy changed', { proxyFingerprint: 'fp-old' }, undefined, 0],
      ['it expires within 15 minutes', { expiresAt: '2026-11-01T12:10:00Z' }, undefined, 0],
      ['its stored name is no Gemini file name', { name: '../cachedContents/x?y=1' }, undefined, 0],
      ['it is gone (404)', {}, () => Promise.reject(apiError(404)), 1],
      ['it belongs to another key (403)', {}, () => Promise.reject(apiError(403)), 1],
      ['it failed', {}, (name) => activeFile({ name, state: FileState.FAILED }), 1],
      [
        'Google says it expires soon',
        {},
        (name) => activeFile({ name, expirationTime: '2026-11-01T12:05:00Z' }),
        1
      ]
    ])('uploads again when %s', async (_label, ref, getKept, keptChecks) => {
      const { analyzer, client, server } = setup({
        client: {
          getFile: (name, call) =>
            name === 'files/kept' && getKept ? getKept(name, call) : activeFile({ name })
        }
      })
      await analyzer.analyze(request({ remoteFile: { ...kept, ...ref } }).req)
      expect(client.calls.get.filter((name) => name === 'files/kept')).toHaveLength(keptChecks)
      expect(server.requests[0].command).toBe('start')
      expect(fileUriOf(client.calls.generate[0])).toBe(UPLOADED_URI)
    })

    it('stops without uploading when cancelled during the check', async () => {
      const controller = new AbortController()
      const { analyzer, client, server } = setup({
        client: {
          getFile: (_name, _call, signal) =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(abortError()))
              controller.abort()
            })
        }
      })
      const error = await failure(
        analyzer.analyze(request({ remoteFile: kept, signal: controller.signal }).req)
      )
      expect(error.code).toBe('cancelled')
      expect(client.calls.get).toEqual(['files/kept'])
      expect(server.requests).toHaveLength(0)
      expect(client.calls.upload).toHaveLength(0)
      expect(client.calls.generate).toHaveLength(0)
    })

    it('remembers a kept upload so a retry after a failure skips the upload', async () => {
      let calls = 0
      const { analyzer, server } = setup({
        client: {
          generate: () => {
            calls++
            if (calls === 1) throw apiError(429, { message: 'quota per day exceeded' })
            return generateResult(validPayload())
          }
        }
      })
      await failure(analyzer.analyze(request().req))
      const uploads = server.requests.length
      const result = await analyzer.analyze(request().req)
      expect(server.requests).toHaveLength(uploads)
      expect(result.remoteFile.name).toBe('files/abc123')
    })
  })

  describe('onRemoteFile', () => {
    const uploaded: RemoteFileRef = {
      name: 'files/abc123',
      uri: UPLOADED_URI,
      mimeType: 'video/mp4',
      expiresAt: '2026-11-03T12:00:00Z',
      proxyFingerprint: 'fp-1'
    }

    it('reports the upload once it is ACTIVE, before Gemini is asked', async () => {
      const events: string[] = []
      const refs: RemoteFileRef[] = []
      const { analyzer } = setup({
        client: {
          getFile: (name, call) => {
            events.push('poll')
            return processingThenActive(name, call)
          },
          generate: () => {
            events.push('generate')
            return generateResult(validPayload())
          }
        }
      })
      const onRemoteFile = (ref: RemoteFileRef): void => {
        events.push('reported')
        refs.push(ref)
      }
      await analyzer.analyze(request({ onRemoteFile }).req)
      expect(refs).toEqual([uploaded])
      expect(events).toEqual(['poll', 'poll', 'reported', 'generate'])
    })

    it('reports a reused file', async () => {
      const kept = { ...uploaded, name: 'files/kept', uri: 'https://example.test/files/kept' }
      const refs: RemoteFileRef[] = []
      const { analyzer, server } = setup({
        client: { getFile: (name) => activeFile({ name, uri: kept.uri }) }
      })
      await analyzer.analyze(
        request({ remoteFile: kept, onRemoteFile: (ref) => refs.push(ref) }).req
      )
      expect(server.requests).toHaveLength(0)
      expect(refs).toEqual([{ ...kept, expiresAt: '2026-11-03T12:00:00Z' }])
    })

    it('reports the upload even when the analysis then fails', async () => {
      const refs: RemoteFileRef[] = []
      const { analyzer } = setup({
        client: { generate: () => Promise.reject(apiError(429, { message: 'quota per day' })) }
      })
      const error = await failure(
        analyzer.analyze(request({ onRemoteFile: (ref) => refs.push(ref) }).req)
      )
      expect(error.code).toBe('quota')
      expect(refs).toEqual([uploaded])
    })

    it('does not report an upload that never became ACTIVE', async () => {
      const refs: RemoteFileRef[] = []
      const { analyzer } = setup({
        client: { getFile: (name) => activeFile({ name, state: FileState.FAILED }) }
      })
      await failure(analyzer.analyze(request({ onRemoteFile: (ref) => refs.push(ref) }).req))
      expect(refs).toEqual([])
    })

    it('survives a throwing callback', async () => {
      const { analyzer, logger } = setup()
      const result = await analyzer.analyze(
        request({
          onRemoteFile: () => {
            throw new Error('store gone')
          }
        }).req
      )
      expect(result.moments).toHaveLength(1)
      expect(logger.entries.some((e) => e.message === 'onRemoteFile callback threw')).toBe(true)
    })
  })

  describe('upload', () => {
    it('falls back to the SDK uploader on protocol errors', async () => {
      const sdkFile = activeFile({ name: 'files/sdk1', uri: 'https://example.test/files/sdk1' })
      const { analyzer, client, logger } = setup({
        server: { omitUploadUrl: true },
        client: { upload: () => sdkFile }
      })
      const { req, stages } = request()
      await analyzer.analyze(req)
      expect(client.calls.upload).toHaveLength(1)
      const call = client.calls.upload[0] as { file: Blob; config: unknown }
      expect(call.file).toBeInstanceOf(Blob)
      expect(call.file.size).toBe(proxy.content.length)
      expect(call.config).toEqual({ mimeType: 'video/mp4', displayName: 'Festival.mp4' })
      expect(stages).toContainEqual(['uploading', -1])
      expect(fileUriOf(client.calls.generate[0])).toBe('https://example.test/files/sdk1')
      expect(logger.entries.some((e) => e.message.includes('falling back'))).toBe(true)
    })

    it('does not fall back when the key is rejected', async () => {
      const { analyzer, client } = setup({
        server: {
          startError: {
            status: 400,
            body: '{"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT"}}'
          }
        }
      })
      const error = await failure(analyzer.analyze(request().req))
      expect(error.code).toBe('auth')
      expect(error.message).toBe(MESSAGES.auth)
      expect(client.calls.upload).toHaveLength(0)
      expect(client.calls.generate).toHaveLength(0)
    })

    it('stops at once when cancelled during the SDK upload and deletes the orphaned file', async () => {
      const controller = new AbortController()
      let finishUpload: (file: GeminiFile) => void = () => undefined
      const { analyzer, client } = setup({
        server: { omitUploadUrl: true },
        client: {
          // like the real files.upload, this ignores the abort and finishes later
          upload: () =>
            new Promise<GeminiFile>((resolve) => {
              finishUpload = resolve
              controller.abort()
            })
        }
      })
      const cleanups: Promise<void>[] = []
      const error = await failure(
        analyzer.analyze(
          request({ signal: controller.signal, onCleanup: (c) => cleanups.push(c) }).req
        )
      )
      expect(error.code).toBe('cancelled')
      expect(client.calls.delete).toEqual([])
      // the caller can wait for the orphan (quitting the app does)
      expect(cleanups).toHaveLength(1)

      finishUpload(activeFile({ name: 'files/sdk1' }))
      await cleanups[0]
      expect(client.calls.delete).toEqual(['files/sdk1'])
      expect(client.calls.generate).toHaveLength(0)
    })

    it('reports a missing upload endpoint as an upload problem, not a model problem', async () => {
      const { analyzer, client } = setup({
        server: { startError: { status: 404, body: '<html>Not Found</html>' } },
        client: { upload: () => Promise.reject(apiError(404, { message: 'Not Found' })) }
      })
      const error = await failure(analyzer.analyze(request().req))
      expect(error.code).toBe('upload')
      expect(error.retryable).toBe(true)
      expect(error.message).toBe(MESSAGES.upload)
      expect(client.calls.upload).toHaveLength(1)
      expect(client.calls.generate).toHaveLength(0)
    })

    it('starts the upload again after a dropped connection', async () => {
      const { analyzer, server } = setup({
        server: { drop: [{ index: 0, kept: 0 }], queryStatus: 400 }
      })
      await analyzer.analyze(request().req)
      expect(server.requests.filter((r) => r.command === 'start')).toHaveLength(2)
      expect(server.received().equals(proxy.content)).toBe(true)
    })

    it('explains a missing proxy file', async () => {
      const { analyzer } = setup()
      const { req } = request()
      const error = await failure(
        analyzer.analyze({ ...req, video: { ...req.video, proxyPath: `${proxy.path}.missing` } })
      )
      expect(error.code).toBe('upload')
      expect(error.message).toBe(MESSAGES.proxyMissing)
    })

    describe('connection outages (festival Wi-Fi)', () => {
      // twelve chunks; the network goes away while the tenth one is sent
      let large: TempFile
      beforeAll(async () => {
        large = await tempFile(12 * CHUNK_GRANULARITY, 'large.mp4')
      })
      afterAll(async () => {
        await large.remove()
      })

      function withOutage(durationMs: number): Setup & { run: () => Promise<AnalyzeResponse> } {
        const s = setup({ server: { outage: { atChunk: 9, durationMs } } })
        const { req } = request()
        const run = (): Promise<AnalyzeResponse> =>
          s.analyzer.analyze({ ...req, video: { ...req.video, proxyPath: large.path } })
        return { ...s, run }
      }

      it.each([1_500, 8_000])(
        'resumes the same session after a %d ms outage instead of starting over',
        async (durationMs) => {
          const { run, server } = withOutage(durationMs)
          const result = await run()
          expect(result.moments).toHaveLength(1)
          expect(sessionCount(server)).toBe(1)
          expect(server.received().equals(large.content)).toBe(true)
          // the dropped chunk is sent twice, nothing else
          expect(sentShare(server, large.content.length)).toBeCloseTo(13 / 12)
        }
      )

      it('still succeeds after a 40 s outage', async () => {
        const { run, server, clock } = withOutage(40_000)
        const result = await run()
        expect(result.moments).toHaveLength(1)
        expect(sessionCount(server)).toBe(1)
        expect(server.received().equals(large.content)).toBe(true)
        // it noticed the network was back within about 15 s
        expect(clock.now - NOW).toBeLessThan(40_000 + 15_000 + 2 * 2_000)
      })

      it('fails as a retryable network error when the outage outlasts the ~2 min window', async () => {
        const { run, server, clock, client } = withOutage(30 * 60_000)
        const error = await failure(run())
        expect(error.code).toBe('network')
        expect(error.retryable).toBe(true)
        expect(error.message).toBe(MESSAGES.network)
        expect(sessionCount(server)).toBe(1)
        expect(clock.now - NOW).toBeGreaterThanOrEqual(100_000)
        expect(clock.now - NOW).toBeLessThanOrEqual(150_000)
        expect(client.calls.generate).toHaveLength(0)
      })

      it('continues the interrupted upload when the analysis is tried again later', async () => {
        const s = withOutage(30 * 60_000)
        await failure(s.run())
        s.clock.now += 30 * 60_000
        const result = await s.run()
        expect(result.moments).toHaveLength(1)
        expect(sessionCount(s.server)).toBe(1)
        expect(s.server.received().equals(large.content)).toBe(true)
        expect(sentShare(s.server, large.content.length)).toBeCloseTo(13 / 12)
      })

      it('starts over when the user cancelled the interrupted upload', async () => {
        const controller = new AbortController()
        const s = setup({
          server: { outage: { atChunk: 9, durationMs: 60_000 } },
          deps: {
            // the user gives up while the app waits for the network
            sleep: async (ms, signal) => {
              s.clock.now += ms
              if (signal && s.clock.now - NOW > 20_000) controller.abort()
              if (signal?.aborted) throw new AnalyzerError('cancelled', 'Cancelled.')
            }
          }
        })
        const { req } = request()
        const video = { ...req.video, proxyPath: large.path }
        const error = await failure(
          s.analyzer.analyze({ ...req, video, signal: controller.signal })
        )
        expect(error.code).toBe('cancelled')
        s.clock.now += 60_000
        await s.analyzer.analyze({ ...req, video })
        expect(sessionCount(s.server)).toBe(2)
      })

      it('uses the finished upload when only the answer to the last chunk was lost', async () => {
        const { analyzer, server } = setup({ server: { loseResponse: (i) => i === 1 } })
        const result = await analyzer.analyze(request().req)
        expect(result.moments).toHaveLength(1)
        expect(sessionCount(server)).toBe(1)
        expect(server.requests.map((r) => r.command)).toEqual([
          'start',
          'upload',
          'upload, finalize',
          'query'
        ])
      })

      it('resumes the session after a server error on a chunk', async () => {
        const { analyzer, server } = setup({
          server: {
            chunkError: (i) => (i === 0 ? { status: 503, body: 'Service Unavailable' } : undefined)
          }
        })
        await analyzer.analyze(request().req)
        expect(sessionCount(server)).toBe(1)
        expect(server.requests.map((r) => [r.command, r.offset])).toEqual([
          ['start', null],
          ['upload', 0],
          ['query', null],
          ['upload', 0],
          ['upload, finalize', CHUNK_GRANULARITY]
        ])
      })
    })
  })

  describe('processing', () => {
    it('reports files Gemini could not process and deletes them', async () => {
      const { analyzer, client } = setup({
        client: {
          getFile: (name) =>
            activeFile({ name, state: FileState.FAILED, error: { message: 'bad video' } })
        }
      })
      const error = await failure(analyzer.analyze(request().req))
      expect(error.code).toBe('processing')
      expect(error.message).toBe(MESSAGES.processing)
      expect(client.calls.generate).toHaveLength(0)
      await vi.waitFor(() => expect(client.calls.delete).toEqual(['files/abc123']))
    })

    it.each([
      ['404', () => apiError(404, { message: 'Requested entity was not found.' })],
      ['403 naming the file', fileGone]
    ])(
      'reports a file that vanished during processing (%s), not a model or key problem',
      async (_label, gone) => {
        const { analyzer, client } = setup({
          client: { getFile: () => Promise.reject(gone()) }
        })
        const error = await failure(analyzer.analyze(request().req))
        expect(error.code).toBe('processing')
        expect(error.retryable).toBe(true)
        expect(error.message).toBe(MESSAGES.fileGone)
        expect(client.calls.get).toHaveLength(1)
        expect(client.calls.generate).toHaveLength(0)
      }
    )

    it('keeps polling through transient errors', async () => {
      const { analyzer, client, logger } = setup({
        client: {
          getFile: (name, call) => {
            if (call === 1) throw networkError()
            if (call === 2) throw apiError(503)
            return activeFile({ name })
          }
        }
      })
      await analyzer.analyze(request().req)
      expect(client.calls.get).toHaveLength(3)
      expect(logger.entries.filter((e) => e.message.includes('polling again'))).toHaveLength(2)
    })

    it('gives up after the processing timeout', async () => {
      const { analyzer, client } = setup({
        client: { getFile: (name) => activeFile({ name, state: FileState.PROCESSING }) },
        deps: { processingTimeoutMs: 10_000 }
      })
      const error = await failure(analyzer.analyze(request().req))
      expect(error.code).toBe('processing')
      expect(error.message).toBe(MESSAGES.processingTimeout)
      expect(client.calls.get.length).toBeLessThanOrEqual(5)
    })
  })

  describe('generateContent', () => {
    it('retries transient failures with backoff', async () => {
      const { analyzer, client, delays } = setup({
        client: {
          generate: (_params, call) => {
            if (call === 1) throw apiError(503, { message: 'The model is overloaded.' })
            if (call === 2) throw networkError()
            return generateResult(validPayload())
          }
        }
      })
      const result = await analyzer.analyze(request().req)
      expect(result.moments).toHaveLength(1)
      expect(client.calls.generate).toHaveLength(3)
      // one 2 s processing poll, then the backoff before attempts 2 and 3
      expect(delays).toEqual([2_000, 1_500, 3_000])
    })

    it.each([
      ['an invalid key', apiError(400, { message: 'API key not valid.' }), 'auth'],
      [
        'an unknown model',
        apiError(404, {
          message:
            'models/gemini-4-argon is not found for API version v1beta, or is not supported for generateContent.',
          status: 'NOT_FOUND'
        }),
        'model'
      ],
      ['the daily quota', apiError(429, { message: 'quota per day exceeded' }), 'quota'],
      ['an empty prepaid balance', apiError(402), 'quota']
    ])('does not retry %s', async (_label, error, code) => {
      const { analyzer, client } = setup({ client: { generate: () => Promise.reject(error) } })
      const mapped = await failure(analyzer.analyze(request({ model: 'gemini-4-argon' }).req))
      expect(mapped.code).toBe(code)
      expect(client.calls.generate).toHaveLength(1)
      // the upload stays for the next attempt
      expect(client.calls.delete).toEqual([])
      if (code === 'model') expect(mapped.message).toContain('“Gemini 4 Argon”')
    })

    it('treats a file that vanished meanwhile as a processing problem and uploads again next time', async () => {
      let calls = 0
      const { analyzer, client, server } = setup({
        client: {
          generate: () => {
            calls++
            if (calls === 1) throw fileGone()
            return generateResult(validPayload())
          }
        }
      })
      const starts = (): number => server.requests.filter((r) => r.command === 'start').length

      const error = await failure(analyzer.analyze(request().req))
      expect(error.code).toBe('processing')
      expect(error.retryable).toBe(true)
      expect(error.message).toBe(MESSAGES.fileGone)
      expect(client.calls.generate).toHaveLength(1)
      expect(starts()).toBe(1)

      const result = await analyzer.analyze(request().req)
      expect(starts()).toBe(2)
      expect(result.moments).toHaveLength(1)
    })

    it('reports safety blocks without retrying', async () => {
      const { analyzer, client } = setup({
        client: { generate: () => generateResult('{}', { blockReason: 'PROHIBITED_CONTENT' }) }
      })
      const error = await failure(analyzer.analyze(request().req))
      expect(error.code).toBe('safety')
      expect(client.calls.generate).toHaveLength(1)
    })

    it('asks once more after an unusable answer and sums the usage', async () => {
      const { analyzer, client } = setup({
        client: {
          generate: (_params, call) =>
            call === 1 ? generateResult('Sorry, no JSON') : generateResult(validPayload())
        }
      })
      const result = await analyzer.analyze(request().req)
      expect(result.moments).toHaveLength(1)
      expect(client.calls.generate).toHaveLength(2)
      expect(promptOf(client.calls.generate[0])).not.toContain('Note:')
      expect(promptOf(client.calls.generate[1])).toContain('Note: Your last answer was incomplete')
      expect(result.usage?.totalTokens).toBe(2 * 52_800)
    })

    it('asks once more after a truncated answer', async () => {
      const { analyzer, client } = setup({
        client: {
          generate: (_params, call) =>
            call === 1
              ? generateResult('{"moments": [', { finishReason: 'MAX_TOKENS' })
              : generateResult(validPayload())
        }
      })
      await analyzer.analyze(request().req)
      expect(client.calls.generate).toHaveLength(2)
    })

    it('fails with invalid-response after two unusable answers', async () => {
      const { analyzer, client } = setup({ client: { generate: () => generateResult('broken') } })
      const error = await failure(analyzer.analyze(request().req))
      expect(error.code).toBe('invalid-response')
      expect(error.message).toBe(MESSAGES.invalidResponse)
      expect(client.calls.generate).toHaveLength(2)
    })

    it('detects answers given without seeing the video', async () => {
      const { analyzer, client } = setup({
        client: { generate: () => generateResult(validPayload(), { videoTokens: 10 }) }
      })
      const error = await failure(analyzer.analyze(request().req))
      expect(error.code).toBe('processing')
      expect(error.message).toBe(MESSAGES.videoNotSeen)
      expect(client.calls.generate).toHaveLength(2)
      expect(promptOf(client.calls.generate[1])).not.toContain('Note:')
    })

    const brokenPayload = {
      videoEndsAt: '01:00',
      moments: [
        {
          start: '00:05',
          peak: '00:07',
          end: '00:10',
          title: 'Good',
          reason: '',
          score: 8
        },
        {
          start: 'soon',
          peak: '',
          end: 'later',
          title: 'Broken',
          reason: '',
          score: 5
        },
        { start: 'x', peak: '', end: 'y', title: 'Broken', reason: '', score: 5 }
      ]
    }

    it('asks once more when too many timestamps are broken and keeps the better answer', async () => {
      const { analyzer, client } = setup({
        client: {
          generate: (_params, call) => generateResult(call === 1 ? brokenPayload : validPayload())
        }
      })
      const result = await analyzer.analyze(request().req)
      expect(result.moments.map((m) => m.title)).toEqual(['Drop with light show'])
      expect(promptOf(client.calls.generate[1])).toContain(
        'Note: Your last answer contained invalid timestamps. The video is exactly 01:00 long'
      )
    })

    it.each([
      ['an unusable second answer', () => generateResult('broken')],
      ['a failing second request', () => Promise.reject(apiError(500))]
    ])('keeps the imperfect first answer after %s', async (_label, second) => {
      const { analyzer } = setup({
        client: {
          generate: (_params, call) => (call === 1 ? generateResult(brokenPayload) : second())
        }
      })
      const result = await analyzer.analyze(request().req)
      expect(result.moments.map((m) => m.title)).toEqual(['Good'])
    })

    it('asks once more with a timestamp hint when stamps overrun and videoEndsAt is wrong', async () => {
      const overrunning = {
        videoEndsAt: '02:00',
        moments: [
          {
            start: '00:10',
            peak: '00:12',
            end: '00:15',
            title: 'Good',
            reason: '',
            score: 7
          },
          {
            start: '00:50',
            peak: '00:55',
            end: '01:10',
            title: 'End',
            reason: '',
            score: 8
          }
        ]
      }
      const { analyzer, client } = setup({
        client: {
          generate: (_params, call) => generateResult(call === 1 ? overrunning : validPayload())
        }
      })
      const result = await analyzer.analyze(request().req)
      expect(client.calls.generate).toHaveLength(2)
      expect(promptOf(client.calls.generate[1])).toContain(
        'Note: Your last answer contained invalid timestamps. The video is exactly 01:00 long'
      )
      expect(result.moments.map((m) => m.title)).toEqual(['Drop with light show'])
    })

    describe('when no timestamp of an answer is usable', () => {
      // a 60 s video: every moment starts after the end
      const pastTheEnd = {
        videoEndsAt: '02:00',
        moments: [
          {
            start: '01:10',
            peak: '01:12',
            end: '01:15',
            title: 'Too late',
            reason: '',
            score: 8
          },
          {
            start: '01:30',
            peak: '01:32',
            end: '01:35',
            title: 'Even later',
            reason: '',
            score: 6
          }
        ]
      }

      it('uses a usable second answer', async () => {
        const { analyzer, client } = setup({
          client: {
            generate: (_params, call) => generateResult(call === 1 ? pastTheEnd : validPayload())
          }
        })
        const result = await analyzer.analyze(request().req)
        expect(result.moments).toHaveLength(1)
        expect(promptOf(client.calls.generate[1])).toContain('invalid timestamps')
      })

      it('fails with the transport error when the extra request fails', async () => {
        const { analyzer, client } = setup({
          client: {
            generate: (_params, call) =>
              call === 1
                ? generateResult(pastTheEnd)
                : Promise.reject(apiError(503, { message: 'The model is overloaded.' }))
          }
        })
        const error = await failure(analyzer.analyze(request().req))
        expect(error.code).toBe('network')
        expect(error.retryable).toBe(true)
        // the first request, then four attempts of the extra one
        expect(client.calls.generate).toHaveLength(5)
      })

      it.each<[string, unknown[]]>([
        ['in both answers', [pastTheEnd, pastTheEnd]],
        ['before an answer that is no JSON', [pastTheEnd, 'broken']],
        ['after an answer that is no JSON', ['broken', pastTheEnd]]
      ])('fails with invalid-response instead of finding nothing (%s)', async (_label, answers) => {
        const { analyzer, client } = setup({
          client: { generate: (_params, call) => generateResult(answers[call - 1]) }
        })
        const error = await failure(analyzer.analyze(request().req))
        expect(error.code).toBe('invalid-response')
        expect(error.retryable).toBe(true)
        expect(error.message).toBe(MESSAGES.invalidResponse)
        expect(client.calls.generate).toHaveLength(2)
      })
    })

    describe('an answer without a single moment', () => {
      // the schema requires at least one: an empty list is a broken answer, not "nothing found"
      const noMoments = { videoEndsAt: '01:00', moments: [] }

      it('asks once more and uses the second answer', async () => {
        const { analyzer, client } = setup({
          client: {
            generate: (_params, call) => generateResult(call === 1 ? noMoments : validPayload())
          }
        })
        const result = await analyzer.analyze(request().req)
        expect(result.moments).toHaveLength(1)
        expect(client.calls.generate).toHaveLength(2)
        expect(promptOf(client.calls.generate[1])).toContain(
          'Note: Your last answer contained no moment.'
        )
      })

      it('fails with invalid-response instead of finding nothing', async () => {
        const { analyzer, client } = setup({
          client: { generate: () => generateResult(noMoments) }
        })
        const error = await failure(analyzer.analyze(request().req))
        expect(error.code).toBe('invalid-response')
        expect(error.retryable).toBe(true)
        expect(error.message).toBe(MESSAGES.invalidResponse)
        expect(client.calls.generate).toHaveLength(2)
      })
    })
  })

  describe('cancellation', () => {
    it('stops during the upload', async () => {
      const controller = new AbortController()
      const { analyzer, client } = setup({
        server: { onChunk: (i) => i === 1 && controller.abort() }
      })
      const error = await failure(analyzer.analyze(request({ signal: controller.signal }).req))
      expect(error.code).toBe('cancelled')
      expect(error.message).toBe('Cancelled.')
      expect(client.calls.generate).toHaveLength(0)
    })

    it('stops while Gemini processes the video and deletes the upload', async () => {
      const controller = new AbortController()
      const { analyzer, client } = setup({
        client: {
          getFile: (name) => {
            controller.abort()
            return activeFile({ name, state: FileState.PROCESSING })
          }
        }
      })
      const error = await failure(analyzer.analyze(request({ signal: controller.signal }).req))
      expect(error.code).toBe('cancelled')
      await vi.waitFor(() => expect(client.calls.delete).toEqual(['files/abc123']))
    })

    it('hands the delete of an upload Gemini was processing to the caller, so quitting can wait', async () => {
      const controller = new AbortController()
      let finishDelete: () => void = () => undefined
      const deleted: string[] = []
      const { analyzer, client } = setup({
        client: {
          getFile: (name) => {
            controller.abort()
            return activeFile({ name, state: FileState.PROCESSING })
          },
          // a slow request on festival Wi-Fi
          deleteFile: (name) =>
            new Promise((resolve) => {
              finishDelete = () => {
                deleted.push(name)
                resolve({})
              }
            })
        }
      })
      const cleanups: Promise<void>[] = []
      const reported: string[] = []
      const { req } = request({
        signal: controller.signal,
        onCleanup: (cleanup) => cleanups.push(cleanup),
        onRemoteFile: (file) => reported.push(file.name)
      })
      // the analysis itself still ends right away
      expect((await failure(analyzer.analyze(req))).code).toBe('cancelled')
      // never reported (not ACTIVE): this cleanup is the only thing that removes the upload
      expect(reported).toEqual([])
      expect(cleanups).toHaveLength(1)
      let settled = false
      void cleanups[0].then(() => (settled = true))
      await vi.waitFor(() => expect(client.calls.delete).toEqual(['files/abc123']))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(settled).toBe(false)
      finishDelete()
      await cleanups[0]
      expect(deleted).toEqual(['files/abc123'])
    })

    it('hands over the delete after a failed processing too', async () => {
      const { analyzer, client } = setup({
        client: {
          getFile: (name) =>
            activeFile({ name, state: FileState.FAILED, error: { message: 'bad video' } })
        }
      })
      const cleanups: Promise<void>[] = []
      await failure(
        analyzer.analyze(request({ onCleanup: (cleanup) => cleanups.push(cleanup) }).req)
      )
      expect(cleanups).toHaveLength(1)
      await Promise.all(cleanups)
      expect(client.calls.delete).toEqual(['files/abc123'])
    })

    it('survives a throwing onCleanup callback – the cleanup runs anyway', async () => {
      const controller = new AbortController()
      const { analyzer, client, logger } = setup({
        client: {
          getFile: (name) => {
            controller.abort()
            return activeFile({ name, state: FileState.PROCESSING })
          }
        }
      })
      const { req } = request({
        signal: controller.signal,
        onCleanup: () => {
          throw new Error('boom')
        }
      })
      expect((await failure(analyzer.analyze(req))).code).toBe('cancelled')
      await vi.waitFor(() => expect(client.calls.delete).toEqual(['files/abc123']))
      expect(logger.entries.some((e) => e.message === 'onCleanup callback threw')).toBe(true)
    })

    it('stops during the analysis', async () => {
      const controller = new AbortController()
      const { analyzer, client } = setup({
        client: {
          generate: (params) =>
            new Promise((_resolve, reject) => {
              params.config?.abortSignal?.addEventListener('abort', () => reject(abortError()))
              setTimeout(() => controller.abort(), 5)
            })
        }
      })
      const cleanups: Promise<void>[] = []
      const { req } = request({
        signal: controller.signal,
        onCleanup: (cleanup) => cleanups.push(cleanup)
      })
      const error = await failure(analyzer.analyze(req))
      expect(error.code).toBe('cancelled')
      expect(client.calls.generate).toHaveLength(1)
      // the upload was reported (ACTIVE): it stays for the next analysis, core owns it
      expect(cleanups).toEqual([])
      expect(client.calls.delete).toEqual([])
    })

    it('does nothing when cancelled before the start', async () => {
      const { analyzer, server } = setup()
      const error = await failure(analyzer.analyze(request({ signal: AbortSignal.abort() }).req))
      expect(error.code).toBe('cancelled')
      expect(server.requests).toHaveLength(0)
    })
  })

  it('survives a throwing progress callback', async () => {
    const { analyzer, logger } = setup()
    const result = await analyzer.analyze(
      request({
        onStage: () => {
          throw new Error('renderer gone')
        }
      }).req
    )
    expect(result.moments).toHaveLength(1)
    expect(logger.entries.some((e) => e.message === 'onStage callback threw')).toBe(true)
  })

  it('creates one SDK client per API key', async () => {
    const { analyzer, createClient } = setup()
    await analyzer.analyze(request().req)
    await analyzer.analyze(request({ apiKey: 'key-1' }).req)
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(createClient).toHaveBeenCalledWith('key-1')
    await analyzer.listModels('key-2')
    expect(createClient).toHaveBeenCalledTimes(2)
  })
})

describe('listModels and testKey', () => {
  const models = [
    {
      name: 'models/gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
      supportedActions: ['generateContent']
    },
    {
      name: 'models/gemini-3.5-flash-lite',
      displayName: 'Gemini 3.5 Flash-Lite',
      supportedActions: ['generateContent']
    },
    {
      name: 'models/gemini-3.1-flash-lite',
      displayName: 'Gemini 3.1 Flash-Lite',
      supportedActions: ['generateContent']
    },
    {
      name: 'models/gemini-4.5-flash',
      displayName: 'Gemini 4.5 Flash',
      supportedActions: ['generateContent']
    },
    {
      name: 'models/gemini-2.5-flash-preview-tts',
      displayName: 'TTS',
      supportedActions: ['generateContent']
    },
    {
      name: 'models/gemini-embedding-001',
      displayName: 'Embedding',
      supportedActions: ['embedContent']
    }
  ]

  it('lists usable models, curated ones first, then newer ones', async () => {
    const { analyzer } = setup({ client: { models } })
    const options = await analyzer.listModels('key')
    expect(options.map((o) => o.id)).toEqual([
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
      'gemini-4.5-flash'
    ])
    expect(options[0].recommended).toBe(true)
  })

  it('confirms a working key', async () => {
    const { analyzer } = setup({ client: { models } })
    const result = await analyzer.testKey('key')
    expect(result.ok).toBe(true)
    expect(result.message).toBe('Connected: 3 models available')
    expect(result.models).toHaveLength(3)
  })

  it('uses the singular for one model', async () => {
    const { analyzer } = setup({ client: { models: models.slice(0, 1) } })
    expect((await analyzer.testKey('key')).message).toBe('Connected: 1 model available')
  })

  it('asks for a key when it is empty', async () => {
    const { analyzer, client } = setup({ client: { models } })
    expect(await analyzer.testKey('   ')).toEqual({
      ok: false,
      message: 'Enter an API key.'
    })
    expect(client.calls.list).toBe(0)
  })

  it('explains a rejected key without pointing to the settings (it is not stored yet)', async () => {
    const { analyzer } = setup({
      client: { models: () => Promise.reject(apiError(400, { message: 'API key not valid.' })) }
    })
    expect(await analyzer.testKey('bad')).toEqual({
      ok: false,
      message: 'Google rejected this API key. Copy it again in full in AI Studio.',
      // core marks a rejected key in use, so Settings no longer says "Connected"
      rejected: true
    })
  })

  it('keeps pointing to the settings when the stored key is rejected during an analysis', async () => {
    const { analyzer } = setup({
      client: { generate: () => Promise.reject(apiError(400, { message: 'API key not valid.' })) }
    })
    const error = await failure(analyzer.analyze(request().req))
    expect(error.message).toBe('Google rejected your API key. Check it in Settings.')
  })

  it('passes other key-test problems on unchanged', async () => {
    const { analyzer } = setup({ client: { models: () => Promise.reject(apiError(402)) } })
    const result = await analyzer.testKey('key')
    expect(result.message).toBe(MESSAGES.billing)
    // not a verdict about the key itself
    expect(result.rejected).toBeUndefined()
  })

  it('retries the model list once after a network error', async () => {
    let calls = 0
    const { analyzer, client } = setup({
      client: {
        models: async () => {
          calls++
          if (calls === 1) throw networkError()
          return (async function* () {
            yield* models
          })()
        }
      }
    })
    expect(await analyzer.listModels('key')).toHaveLength(3)
    expect(client.calls.list).toBe(2)
  })

  it('maps a persistent network error', async () => {
    const { analyzer } = setup({ client: { models: () => Promise.reject(networkError()) } })
    const error = await failure(analyzer.listModels('key'))
    expect(error.code).toBe('network')
    expect((await analyzer.testKey('key')).message).toBe(MESSAGES.network)
  })
})

describe('deleteRemoteFile', () => {
  it('deletes the file', async () => {
    const { analyzer, client, logger } = setup()
    await analyzer.deleteRemoteFile('key', 'files/abc')
    expect(client.calls.delete).toEqual(['files/abc'])
    expect(logger.entries).toEqual([])
  })

  it('never puts a name that is no Gemini file name into a request path', async () => {
    const { analyzer, client } = setup()
    await analyzer.deleteRemoteFile('key', '../cachedContents/x?y=1')
    expect(client.calls.delete).toEqual([])
  })

  it.each([
    ['404', () => apiError(404)],
    ['403 naming the file', fileGone]
  ])('ignores files that are already gone (%s)', async (_label, gone) => {
    const { analyzer, logger } = setup({
      client: { deleteFile: () => Promise.reject(gone()) }
    })
    await expect(analyzer.deleteRemoteFile('key', 'files/abc')).resolves.toBeUndefined()
    expect(logger.entries).toEqual([])
  })

  it('logs other failures instead of throwing', async () => {
    const { analyzer, logger } = setup({
      client: { deleteFile: () => Promise.reject(apiError(500)) }
    })
    await expect(analyzer.deleteRemoteFile('key', 'files/abc')).resolves.toBeUndefined()
    expect(logger.entries.map((e) => e.message)).toEqual(['could not delete the remote file'])
  })

  it('never hangs', async () => {
    vi.useFakeTimers()
    const { analyzer, logger } = setup({
      client: { deleteFile: () => new Promise(() => undefined) }
    })
    const pending = analyzer.deleteRemoteFile('key', 'files/abc')
    await vi.advanceTimersByTimeAsync(16_000)
    await expect(pending).resolves.toBeUndefined()
    expect(logger.entries.map((e) => e.message)).toEqual(['deleting the remote file timed out'])
  })
})
