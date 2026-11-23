import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fingerprintFile } from './fingerprint'

const MiB = 1024 * 1024

describe('fingerprintFile', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hc-fingerprint-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is size-mtime-sha1(first MiB + last MiB)', async () => {
    const data = Buffer.alloc(3 * MiB)
    for (let i = 0; i < data.length; i++) data[i] = (i * 31) % 251
    const path = join(dir, 'big.bin')
    await writeFile(path, data)
    await utimes(path, new Date('2026-07-12T19:14:05Z'), new Date('2026-07-12T19:14:05.250Z'))

    const expected = createHash('sha1')
      .update(data.subarray(0, MiB))
      .update(data.subarray(2 * MiB))
      .digest('hex')
    expect(await fingerprintFile(path)).toBe(
      `${3 * MiB}-${Date.parse('2026-07-12T19:14:05.250Z')}-${expected}`
    )
  })

  it('hashes small files twice (overlapping ranges) and stays deterministic', async () => {
    const path = join(dir, 'small.bin')
    await writeFile(path, 'hello')
    const { mtimeMs } = await stat(path)
    const sha = createHash('sha1').update('hello').update('hello').digest('hex')
    expect(await fingerprintFile(path)).toBe(`5-${Math.floor(mtimeMs)}-${sha}`)
    expect(await fingerprintFile(path)).toBe(await fingerprintFile(path))
  })

  it('changes when the end of the file changes', async () => {
    const path = join(dir, 'tail.bin')
    const data = Buffer.alloc(2 * MiB + 10, 1)
    await writeFile(path, data)
    const fixed = new Date('2026-01-01T00:00:00Z')
    await utimes(path, fixed, fixed)
    const before = await fingerprintFile(path)
    data[data.length - 1] = 2
    await writeFile(path, data)
    await utimes(path, fixed, fixed)
    expect(await fingerprintFile(path)).not.toBe(before)
  })

  it('throws a user-facing error for missing files', async () => {
    await expect(fingerprintFile(join(dir, 'missing.mp4'))).rejects.toMatchObject({
      code: 'invalid',
      message: 'The file “missing.mp4” was not found.'
    })
  })
})
