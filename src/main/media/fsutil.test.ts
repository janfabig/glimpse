import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaError } from '../contracts'
import { MESSAGES } from './errors'
import {
  moveToFreeName,
  namingFullOutputFolder,
  nextFreeName,
  sameVolume,
  tempSiblingPath,
  writeAtomically,
  writeNewFile
} from './fsutil'

// link() can be made to fail like on exFAT (no hard links); everything else is the real module
const linkFailure = vi.hoisted(() => ({ code: null as string | null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    link: async (existing: string, created: string): Promise<void> => {
      if (linkFailure.code !== null) {
        throw Object.assign(new Error(`${linkFailure.code}: link`), { code: linkFailure.code })
      }
      return real.link(existing, created)
    }
  }
})

describe('tempSiblingPath', () => {
  it('is a hidden sibling with the same extension', () => {
    const temp = tempSiblingPath('/out/My Reel – Highlights.mp4')
    expect(dirname(temp)).toBe('/out')
    expect(basename(temp)).toMatch(/^\.My Reel – Highlights\.[0-9a-f]{8}\.part\.mp4$/)
    expect(tempSiblingPath('/out/a.mp4')).not.toBe(tempSiblingPath('/out/a.mp4'))
  })
})

describe('writeAtomically', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hc-atomic-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('creates missing folders and moves the result into place', async () => {
    const target = join(dir, 'nested', 'poster.jpg')
    const result = await writeAtomically(target, async (temp) => {
      expect(temp).not.toBe(target)
      await writeFile(temp, 'jpeg')
      return 42
    })
    expect(result).toBe(42)
    expect(await readFile(target, 'utf8')).toBe('jpeg')
    expect(await readdir(join(dir, 'nested'))).toEqual(['poster.jpg'])
  })

  it('removes the temp file and keeps an existing target when producing fails', async () => {
    const target = join(dir, 'proxy.mp4')
    await writeFile(target, 'old')
    await expect(
      writeAtomically(target, async (temp) => {
        await writeFile(temp, 'half')
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(await readdir(dir)).toEqual(['proxy.mp4'])
    expect(await readFile(target, 'utf8')).toBe('old')
  })
})

describe('nextFreeName', () => {
  it('continues the " (n)" series', () => {
    expect(nextFreeName('/out/Reel – Highlights 2026-07-12 21.14.mp4')).toBe(
      '/out/Reel – Highlights 2026-07-12 21.14 (2).mp4'
    )
    expect(nextFreeName('/out/Reel (2).mp4')).toBe('/out/Reel (3).mp4')
    expect(nextFreeName('/out/Reel (9).mp4')).toBe('/out/Reel (10).mp4')
    expect(nextFreeName('/out/(2).mp4')).toBe('/out/(2) (2).mp4')
  })
})

describe('moveToFreeName / writeNewFile', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hc-free-'))
    linkFailure.code = null
  })
  afterEach(async () => {
    linkFailure.code = null
    await rm(dir, { recursive: true, force: true })
  })

  /** the volume treats names differing in case as the same file (APFS default) */
  async function caseInsensitive(): Promise<boolean> {
    await writeFile(join(dir, 'probe-case'), '')
    const result = await lstat(join(dir, 'PROBE-CASE')).then(
      () => true,
      () => false
    )
    await rm(join(dir, 'probe-case'))
    return result
  }

  it('never replaces an existing file and reports the name it used', async () => {
    const target = join(dir, 'Summer party – Highlights.mp4')
    await writeFile(target, 'first')
    const { result, path } = await writeNewFile(target, async (temp) => {
      await writeFile(temp, 'second')
      return 'done'
    })
    expect(result).toBe('done')
    expect(path).toBe(join(dir, 'Summer party – Highlights (2).mp4'))
    expect(await readFile(target, 'utf8')).toBe('first')
    expect(await readFile(path, 'utf8')).toBe('second')
    expect((await readdir(dir)).sort()).toEqual([basename(target), basename(path)].sort())
  })

  it('treats names as the file system does (case, Unicode normalisation)', async () => {
    await writeFile(join(dir, 'Summer party.mp4'), 'upper')
    await writeFile(join(dir, 'Gr\u00fcnfest.mp4'), 'nfc')
    const write = async (name: string): Promise<string> =>
      (await writeNewFile(join(dir, name), (temp) => writeFile(temp, name))).path
    const lower = await write('summer party.mp4')
    const nfd = await write('Gru\u0308nfest.mp4')
    if (await caseInsensitive()) {
      expect(basename(lower)).toBe('summer party (2).mp4')
      expect(basename(nfd).normalize('NFC')).toBe('Gr\u00fcnfest (2).mp4')
    }
    expect(await readFile(join(dir, 'Summer party.mp4'), 'utf8')).toBe('upper')
    expect(await readFile(join(dir, 'Gr\u00fcnfest.mp4'), 'utf8')).toBe('nfc')
    expect((await readdir(dir)).length).toBe(4)
  })

  it('falls back to check-then-rename where hard links are not supported (exFAT)', async () => {
    linkFailure.code = 'ENOTSUP'
    const target = join(dir, 'reel.mp4')
    await writeFile(target, 'first')
    const temp = join(dir, '.reel.part.mp4')
    await writeFile(temp, 'second')
    expect(await moveToFreeName(temp, target)).toBe(join(dir, 'reel (2).mp4'))
    expect(await readFile(target, 'utf8')).toBe('first')
    expect((await readdir(dir)).sort()).toEqual(['reel (2).mp4', 'reel.mp4'])
  })

  it('keeps replacing for writeAtomically (proxies, posters, sprites)', async () => {
    const target = join(dir, 'proxy.mp4')
    await writeFile(target, 'old')
    await writeAtomically(target, (temp) => writeFile(temp, 'new'))
    expect(await readFile(target, 'utf8')).toBe('new')
    expect(await readdir(dir)).toEqual(['proxy.mp4'])
  })
})

describe('namingFullOutputFolder', () => {
  const full = (): MediaError =>
    new MediaError('ffmpeg', MESSAGES.diskFull, 'Error writing trailer: No space left on device')

  it('names an export folder on another volume than the work files (an external drive)', async () => {
    const work = await mkdtemp(join(tmpdir(), 'hc-work-'))
    try {
      // /dev is a volume of its own (devfs) – like an external SSD next to the Mac's disk
      expect(await sameVolume('/dev', work)).toBe(false)
      const error = await namingFullOutputFolder('/dev/Reel.mp4', work, () =>
        Promise.reject(full())
      ).catch((err: unknown) => err)
      expect(error).toBeInstanceOf(MediaError)
      expect((error as MediaError).message).toBe(MESSAGES.outputFolderFull('/dev'))
      expect((error as MediaError).message).toBe(
        'There is not enough free space in the export folder “/dev”. Free up space there or ' +
          'choose another export folder when you export.'
      )
      expect((error as MediaError).details).toContain('No space left on device')

      // the same volume as the work files: the Mac's disk is full
      const same = await namingFullOutputFolder(join(work, 'Reel.mp4'), work, () =>
        Promise.reject(full())
      ).catch((err: unknown) => err)
      expect((same as MediaError).message).toBe(MESSAGES.diskFull)

      // other failures pass unchanged, results too
      const other = new MediaError('ffmpeg', MESSAGES.join, 'Invalid data')
      await expect(
        namingFullOutputFolder('/dev/Reel.mp4', work, () => Promise.reject(other))
      ).rejects.toBe(other)
      expect(await namingFullOutputFolder('/dev/Reel.mp4', work, async () => 7)).toBe(7)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })
})
