import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { open } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { MediaError } from '../contracts'
import { fsFailure, MESSAGES } from './errors'

const CHUNK_BYTES = 1024 * 1024

/**
 * `${size}-${mtimeMs}-${sha1(first MiB + last MiB)}` – cheap enough for multi-GB files and stable
 * across renames; detects duplicates and changed files. For files under 2 MiB the two ranges
 * overlap, which is fine (still deterministic).
 */
export async function fingerprintFile(path: string): Promise<string> {
  let handle: FileHandle
  try {
    handle = await open(path, 'r')
  } catch (err) {
    const message = fsFailure(err, dirname(path), 'read') ?? MESSAGES.missingFile(basename(path))
    throw new MediaError('invalid', message, String(err))
  }
  try {
    const info = await handle.stat()
    const hash = createHash('sha1')
    const firstLength = Math.min(CHUNK_BYTES, info.size)
    const lastStart = Math.max(0, info.size - CHUNK_BYTES)
    for (const [position, length] of [
      [0, firstLength],
      [lastStart, info.size - lastStart]
    ]) {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      hash.update(buffer.subarray(0, bytesRead))
    }
    return `${info.size}-${Math.floor(info.mtimeMs)}-${hash.digest('hex')}`
  } catch (err) {
    if (err instanceof MediaError) throw err
    throw new MediaError('invalid', MESSAGES.unreadable, String(err))
  } finally {
    await handle.close()
  }
}
