import { ApiError, type File as GeminiFile } from '@google/genai'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AnalyzerError } from '../contracts'
import { classifyError } from './errors'
import { MESSAGES } from './messages'
import {
  instantSleep,
  sessionCount,
  tempFile,
  UPLOAD_BASE,
  uploadServer,
  type TempFile,
  type UploadServer,
  type UploadServerOptions
} from './testSupport'
import {
  CHUNK_GRANULARITY,
  CHUNK_TIMEOUT_MIN_MS,
  chunkTimeoutMs,
  UploadProtocolError,
  uploadResumable,
  type ResumableUploadOptions,
  type UploadSession
} from './upload'

const CHUNK = CHUNK_GRANULARITY // 256 KiB keeps the test files small
let file: TempFile
let unevenFile: TempFile

beforeAll(async () => {
  file = await tempFile(4 * CHUNK)
  unevenFile = await tempFile(2 * CHUNK + 100, 'Fëstival 🎉.mp4')
})

afterAll(async () => {
  await file.remove()
  await unevenFile.remove()
})

function upload(
  server: UploadServer,
  overrides: Partial<ResumableUploadOptions> = {}
): { promise: Promise<GeminiFile>; progress: number[] } {
  const progress: number[] = []
  const promise = uploadResumable({
    apiKey: 'test-key',
    filePath: file.path,
    mimeType: 'video/mp4',
    displayName: 'Festival day 1.mp4',
    baseUrl: `${UPLOAD_BASE}/`,
    fetch: server.fetch,
    sleep: instantSleep().sleep,
    chunkSize: CHUNK,
    onProgress: (fraction) => progress.push(fraction),
    ...overrides
  })
  return { promise, progress }
}

/** the final error after the connection stayed away: retryable for the user, not retried inside */
function expectConnectionLost(error: unknown): void {
  expect(error).toBeInstanceOf(AnalyzerError)
  expect(error).toMatchObject({ code: 'network', retryable: true, message: MESSAGES.network })
}

describe('uploadResumable', () => {
  it('uploads the file in chunks with the resumable protocol', async () => {
    const server = uploadServer()
    const { promise, progress } = upload(server)
    const result = await promise

    expect(result).toMatchObject({
      name: 'files/abc123',
      state: 'PROCESSING',
      mimeType: 'video/mp4'
    })
    expect(server.received().equals(file.content)).toBe(true)
    expect(progress).toEqual([0, 0.25, 0.5, 0.75, 1])

    const [start, ...chunks] = server.requests
    expect(start.url).toBe(`${UPLOAD_BASE}/upload/v1beta/files`)
    expect(start.headers).toMatchObject({
      'x-goog-api-key': 'test-key',
      'content-type': 'application/json',
      'x-goog-upload-protocol': 'resumable',
      'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': String(4 * CHUNK),
      'x-goog-upload-header-content-type': 'video/mp4'
    })
    expect(JSON.parse(start.body ?? '')).toEqual({
      file: {
        displayName: 'Festival day 1.mp4',
        mimeType: 'video/mp4',
        sizeBytes: String(4 * CHUNK)
      }
    })
    expect(chunks.map((r) => [r.command, r.offset, r.bytes])).toEqual([
      ['upload', 0, CHUNK],
      ['upload', CHUNK, CHUNK],
      ['upload', 2 * CHUNK, CHUNK],
      ['upload, finalize', 3 * CHUNK, CHUNK]
    ])
    expect(chunks.every((r) => r.headers['x-goog-api-key'] === 'test-key')).toBe(true)
  })

  it('sends a shorter last chunk and keeps non-Latin-1 names in the JSON body', async () => {
    const server = uploadServer()
    await upload(server, { filePath: unevenFile.path, displayName: 'Fëstival 🎉.mp4' }).promise
    expect(server.received().equals(unevenFile.content)).toBe(true)
    expect(server.requests.slice(1).map((r) => r.bytes)).toEqual([CHUNK, CHUNK, 100])
    expect(JSON.parse(server.requests[0].body ?? '').file.displayName).toBe('Fëstival 🎉.mp4')
  })

  it('uses 8 MiB chunks by default (one request for a small file)', async () => {
    const server = uploadServer()
    await upload(server, { chunkSize: undefined }).promise
    expect(server.requests.map((r) => r.command)).toEqual(['start', 'upload, finalize'])
  })

  it('rejects chunk sizes that are not multiples of 256 KiB', async () => {
    await expect(upload(uploadServer(), { chunkSize: 100_000 }).promise).rejects.toThrow(RangeError)
  })

  describe('protocol errors (→ SDK fallback)', () => {
    it.each<[string, UploadServerOptions]>([
      ['no upload URL', { omitUploadUrl: true }],
      ['session ended early', { chunkStatus: (i) => (i === 1 ? 'cancelled' : undefined) }],
      ['missing status header', { chunkStatus: (i) => (i === 0 ? null : undefined) }],
      ['not finalized', { chunkStatus: (i) => (i === 3 ? 'active' : undefined) }],
      ['final response without file', { finalBody: { ok: true } }],
      [
        'HTTP 400 on start',
        { startError: { status: 400, body: '{"error":{"message":"Bad header"}}' } }
      ],
      [
        'HTTP 404 on a chunk',
        { chunkError: (i) => (i === 2 ? { status: 404, body: 'Not Found' } : undefined) }
      ]
    ])('%s', async (_label, options) => {
      await expect(upload(uploadServer(options)).promise).rejects.toBeInstanceOf(
        UploadProtocolError
      )
    })
  })

  describe('real answers (no fallback)', () => {
    it.each([
      [
        400,
        '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}',
        'auth'
      ],
      [403, '{"error":{"code":403,"message":"Permission denied"}}', 'auth'],
      [429, '{"error":{"code":429,"message":"Resource exhausted"}}', 'quota-minute'],
      [503, 'Service Unavailable', 'server']
    ])('HTTP %d becomes an ApiError (%s)', async (status, body, kind) => {
      const error = await upload(uploadServer({ startError: { status, body } })).promise.catch(
        (e: unknown) => e
      )
      expect(error).toBeInstanceOf(ApiError)
      expect(classifyError(error).kind).toBe(kind)
    })
  })

  describe('dropped connections', () => {
    it('resumes at the offset the server reports', async () => {
      const server = uploadServer({ drop: [{ index: 1, kept: 1_000 }] })
      const { promise, progress } = upload(server)
      await promise
      expect(server.received().equals(file.content)).toBe(true)
      const commands = server.requests.map((r) => [r.command, r.offset])
      expect(commands).toEqual([
        ['start', null],
        ['upload', 0],
        ['upload', CHUNK],
        ['query', null],
        ['upload', CHUNK + 1_000],
        ['upload', 2 * CHUNK + 1_000],
        ['upload, finalize', 3 * CHUNK + 1_000]
      ])
      expect(progress.at(-1)).toBe(1)
    })

    it('gives up when the server cannot tell how much it received', async () => {
      const server = uploadServer({ drop: [{ index: 0, kept: 0 }], queryStatus: 400 })
      const error = await upload(server).promise.catch((e: unknown) => e)
      expect(classifyError(error).kind).toBe('network')
    })

    it('gives up when the server does not report the received size', async () => {
      const server = uploadServer({ drop: [{ index: 1, kept: 10 }], querySize: false })
      const error = await upload(server).promise.catch((e: unknown) => e)
      expect(classifyError(error).kind).toBe('network')
      expect(server.requests.map((r) => r.command)).toEqual(['start', 'upload', 'upload', 'query'])
    })

    it('gives up after three resumes without progress', async () => {
      const drops = [0, 1, 2, 3].map((index) => ({ index, kept: 0 }))
      const server = uploadServer({ drop: drops })
      const error = await upload(server).promise.catch((e: unknown) => e)
      expectConnectionLost(error)
      expect(server.requests.filter((r) => r.command === 'query')).toHaveLength(3)
    })

    it('keeps resuming as long as the server receives more', async () => {
      const drops = [0, 1, 2, 3, 4].map((index) => ({ index, kept: CHUNK / 2 }))
      const server = uploadServer({ drop: drops })
      await upload(server).promise
      expect(server.received().equals(file.content)).toBe(true)
      expect(sessionCount(server)).toBe(1)
    })
  })

  describe('network outages', () => {
    function timed(
      server: UploadServer,
      clock: { now: number },
      overrides: Partial<ResumableUploadOptions> = {}
    ): { promise: Promise<GeminiFile>; delays: number[] } {
      const { sleep, delays } = instantSleep(clock)
      return {
        promise: upload(server, { sleep, now: () => clock.now, ...overrides }).promise,
        delays
      }
    }

    it('asks for the upload status with growing pauses until the network is back', async () => {
      const clock = { now: 0 }
      const server = uploadServer({
        outage: { atChunk: 1, durationMs: 40_000 },
        now: () => clock.now
      })
      const { promise, delays } = timed(server, clock)
      await promise
      expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000])
      expect(server.received().equals(file.content)).toBe(true)
      expect(sessionCount(server)).toBe(1)
    })

    it('gives up after about two minutes and keeps the session for a later attempt', async () => {
      const clock = { now: 0 }
      const server = uploadServer({
        outage: { atChunk: 2, durationMs: 60 * 60_000 },
        now: () => clock.now
      })
      const session: UploadSession = { url: null }
      const { promise, delays } = timed(server, clock, { session })
      expectConnectionLost(await promise.catch((e: unknown) => e))
      const waited = delays.reduce((sum, ms) => sum + ms, 0)
      expect(waited).toBeGreaterThanOrEqual(100_000)
      expect(waited).toBeLessThanOrEqual(120_000)
      expect(session.url).not.toBeNull()

      clock.now += 60 * 60_000
      const progress: number[] = []
      await timed(server, clock, { session, onProgress: (f) => progress.push(f) }).promise
      expect(server.received().equals(file.content)).toBe(true)
      expect(sessionCount(server)).toBe(1)
      expect(progress[0]).toBe(0.5)
      expect(server.requests.slice(-3).map((r) => [r.command, r.offset])).toEqual([
        ['query', null],
        ['upload', 2 * CHUNK],
        ['upload, finalize', 3 * CHUNK]
      ])
    })

    it('starts a new session when the old one cannot be resumed', async () => {
      const server = uploadServer({ queryStatus: 404 })
      const session: UploadSession = { url: `${UPLOAD_BASE}/upload/v1beta/files?upload_id=expired` }
      await upload(server, { session }).promise
      expect(server.requests.map((r) => r.command)).toEqual([
        'query',
        'start',
        'upload',
        'upload',
        'upload',
        'upload, finalize'
      ])
      expect(session.url).not.toContain('expired')
    })
  })

  describe('stalled connections', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    function stallAt(index: number): { server: UploadServer; stalled: Promise<void> } {
      let reached: () => void = () => undefined
      const stalled = new Promise<void>((resolve) => (reached = resolve))
      const server = uploadServer({
        hang: (i) => {
          if (i !== index) return false
          reached()
          return true
        }
      })
      return { server, stalled }
    }

    it(
      'abandons a stalled chunk after the chunk timeout and resumes',
      { timeout: 5_000 },
      async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        const { server, stalled } = stallAt(1)
        const { promise } = upload(server)
        await stalled
        await vi.advanceTimersByTimeAsync(CHUNK_TIMEOUT_MIN_MS)
        await promise
        expect(server.received().equals(file.content)).toBe(true)
        expect(server.requests.map((r) => [r.command, r.offset])).toEqual([
          ['start', null],
          ['upload', 0],
          ['upload', CHUNK],
          ['query', null],
          ['upload', CHUNK],
          ['upload', 2 * CHUNK],
          ['upload, finalize', 3 * CHUNK]
        ])
      }
    )

    it('stops at once when cancelled during a stalled chunk', { timeout: 5_000 }, async () => {
      const controller = new AbortController()
      const { server, stalled } = stallAt(1)
      const { promise } = upload(server, { signal: controller.signal })
      await stalled
      controller.abort()
      const error = await promise.catch((e: unknown) => e)
      expect(classifyError(error, controller.signal).kind).toBe('cancelled')
      expect(server.requests.map((r) => r.command)).toEqual(['start', 'upload', 'upload'])
    })
  })

  describe('chunkTimeoutMs', () => {
    const MiB = 1024 * 1024

    it('allows a slow link (64 KiB/s) for the first chunk', () => {
      expect(chunkTimeoutMs(8 * MiB, null, 0)).toBe(128_000)
    })

    it('expects four times the measured duration, but at least 30 s', () => {
      // 8 MiB in 20 s
      expect(chunkTimeoutMs(8 * MiB, 20_000 / (8 * MiB), 0)).toBe(80_000)
      // 8 MiB in 2 s
      expect(chunkTimeoutMs(8 * MiB, 2_000 / (8 * MiB), 0)).toBe(CHUNK_TIMEOUT_MIN_MS)
      expect(chunkTimeoutMs(0, null, 0)).toBe(CHUNK_TIMEOUT_MIN_MS)
    })

    it('doubles after every timeout, up to 10 minutes', () => {
      expect(chunkTimeoutMs(8 * MiB, null, 1)).toBe(256_000)
      expect(chunkTimeoutMs(8 * MiB, null, 2)).toBe(512_000)
      expect(chunkTimeoutMs(8 * MiB, null, 3)).toBe(10 * 60_000)
    })
  })

  it('stops when cancelled', async () => {
    const controller = new AbortController()
    const server = uploadServer({ onChunk: (i) => i === 1 && controller.abort() })
    const error = await upload(server, { signal: controller.signal }).promise.catch(
      (e: unknown) => e
    )
    expect(classifyError(error, controller.signal).kind).toBe('cancelled')
    expect(server.requests.map((r) => r.command)).toEqual(['start', 'upload', 'upload'])
  })

  it('does not start when already cancelled', async () => {
    const server = uploadServer()
    const error = await upload(server, { signal: AbortSignal.abort() }).promise.catch(
      (e: unknown) => e
    )
    expect(error).toBeInstanceOf(AnalyzerError)
    expect(server.requests).toHaveLength(0)
  })
})
