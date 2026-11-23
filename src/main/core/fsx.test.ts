import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tempSiblingPath } from '../media/fsutil'
import { removeStalePartFiles } from './fsx'

describe('removeStalePartFiles', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hc-parts-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function aged(name: string, minutes: number): Promise<string> {
    const file = join(dir, name)
    await writeFile(file, 'x'.repeat(10))
    const at = new Date(Date.now() - minutes * 60_000)
    await utimes(file, at, at)
    return name
  }

  it('removes the temp files a killed run left behind, and nothing else', async () => {
    // the names media really uses (a killed join, a killed poster)
    const reel = basename(tempSiblingPath(join(dir, 'Festival – Highlights 2026-07-12 21.14.mp4')))
    const poster = basename(tempSiblingPath(join(dir, 'poster.jpg')))
    await aged(reel, 5)
    await aged(poster, 5)
    const kept = [
      await aged('Festival – Highlights 2026-07-12 21.14.mp4', 5),
      // hidden, but not the app's pattern
      await aged('.DS_Store', 5),
      await aged('.Reel.part.mp4', 5),
      await aged('.Reel.3fa2c1d.part.mp4', 5),
      await aged('Reel.3fa2c1d0.part.mp4', 5),
      // written a moment ago: a run that is still going on (this or another instance of the app)
      await aged('.Running.0a1b2c3d.part.mp4', 0)
    ]
    // a folder and a link with the pattern's name are left alone
    await mkdir(join(dir, '.Folder.3fa2c1d0.part.mp4'))
    await symlink(join(dir, kept[0]), join(dir, '.Link.3fa2c1d0.part.mp4'))

    expect(await removeStalePartFiles(dir)).toBe(2)
    expect((await readdir(dir)).sort()).toEqual(
      [...kept, '.Folder.3fa2c1d0.part.mp4', '.Link.3fa2c1d0.part.mp4'].sort()
    )
  })

  it('is quiet about a folder that does not exist', async () => {
    expect(await removeStalePartFiles(join(dir, 'missing'))).toBe(0)
  })
})
