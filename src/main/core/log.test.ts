import { chmod, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MediaError } from '../contracts'
import { AppLogger, rotatedName, serialize } from './log'
import { makeTempDir, type TempDir } from './testing/helpers'

let temp: TempDir

beforeEach(async () => {
  temp = await makeTempDir('hc-log-')
})

afterEach(async () => {
  await temp.cleanup()
})

const fixedNow = (): Date => new Date('2026-07-12T20:00:00.000Z')

describe('AppLogger', () => {
  it('writes formatted lines to the log file', async () => {
    const log = new AppLogger({ console: false, now: fixedNow })
    const file = join(temp.path, 'logs', 'main.log')
    log.info('early', 'before the file is attached')
    log.attachFile(file)
    log.info('jobs', 'started', { projectId: 'p1' })
    log.error('export', 'failed', new MediaError('ffmpeg', 'Broken.', 'stderr tail'))
    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    expect(lines[0]).toBe('2026-07-12T20:00:00.000Z INFO  [jobs] started {"projectId":"p1"}')
    expect(lines[1]).toContain(
      'ERROR [export] failed {"name":"MediaError","message":"Broken.","code":"ffmpeg","details":"stderr tail"'
    )
    expect(lines).toHaveLength(2)
  })

  it('rotates the file once it grows beyond the limit', async () => {
    const log = new AppLogger({ console: false, maxBytes: 300, now: fixedNow })
    const file = join(temp.path, 'main.log')
    log.attachFile(file)
    for (let i = 0; i < 10; i++) log.info('test', `line ${i} ${'x'.repeat(40)}`)
    expect((await readdir(temp.path)).sort()).toEqual(['main.1.log', 'main.log'])
    const current = await readFile(file, 'utf8')
    expect(Buffer.byteLength(current)).toBeLessThanOrEqual(300)
    expect(current).toContain('line 9')
    expect(rotatedName('/x/main.log')).toBe('/x/main.1.log')
  })

  it('never writes API keys – registered, recognisable or in sensitive fields', async () => {
    const log = new AppLogger({ console: false, now: fixedNow })
    const file = join(temp.path, 'main.log')
    log.attachFile(file)
    log.addSecret('my-custom-secret-123')
    log.info('settings', 'key my-custom-secret-123 stored')
    log.warn('ai', 'request failed for AIzaSyA1234567890abcdefghijklmnopqrstuv', {
      url: 'https://x/?key=AIzaSyA1234567890abcdefghijklmnopqrstuv'
    })
    log.info('ai', 'request', {
      apiKey: 'plain',
      headers: { 'x-goog-api-key': 'plain2', Authorization: 'Bearer t' },
      usage: { promptTokens: 12 }
    })
    const text = await readFile(file, 'utf8')
    expect(text).not.toContain('my-custom-secret-123')
    expect(text).not.toContain('AIzaSyA1234567890')
    expect(text).not.toContain('plain')
    expect(text).not.toContain('Bearer')
    expect(text).toContain('"promptTokens":12')
  })

  it('keeps the file sink when a write fails and tries again later (e.g. a full disk)', async () => {
    let now = Date.parse('2026-07-12T20:00:00.000Z')
    const log = new AppLogger({ console: false, now: () => new Date(now), fileRetryMs: 30_000 })
    const file = join(temp.path, 'main.log')
    log.attachFile(file)
    log.info('test', 'first')
    await chmod(file, 0o444)
    try {
      log.info('test', 'lost while the file is not writable')
      now += 10_000
      log.info('test', 'still waiting')
    } finally {
      await chmod(file, 0o644)
    }
    // before the retry time nothing is written, even though the file works again
    log.info('test', 'too early')
    now += 25_000
    log.info('test', 'back again')
    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('first')
    expect(lines[1]).toContain('[log] 3 line(s) could not be written to the log file')
    expect(lines[2]).toContain('back again')
  })

  it('survives circular data and unserialisable values', () => {
    const data: Record<string, unknown> = { n: 1n }
    data.self = data
    expect(serialize(data)).toBe('{"n":"1","self":"[circular]"}')
    expect(serialize('x'.repeat(5000)).length).toBeLessThan(4100)
  })
})
