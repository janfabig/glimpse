// Small file-system helpers shared by the stores and jobs.

import { lstat, mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'

let tmpCounter = 0

/**
 * Writes `data` to a temp file next to `file`, fsyncs it and renames it over `file`, so readers
 * (and a crash) only ever see the old or the complete new content.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  options: { mode?: number } = {}
): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`
  try {
    const handle = await open(tmp, 'w', options.mode ?? 0o644)
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, file)
  } catch (err) {
    await unlink(tmp).catch(() => undefined)
    throw err
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export async function removePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
}

/** media's hidden temp name of a file it is writing: `.<name>.<8 hex digits>.part.<ext>` */
const PART_FILE = /^\..+\.[0-9a-f]{8}\.part\.[a-z0-9]+$/
/** a temp file that was written this recently may belong to a run that is still going on */
const PART_STALE_MS = 60_000

/**
 * Removes the temp files in `dir` that media left behind when the app or the Mac died while
 * ffmpeg was writing (up to a whole highlight video, hidden in Finder). Best effort; returns
 * how many were removed.
 */
export async function removeStalePartFiles(dir: string): Promise<number> {
  const names = await readdir(dir).catch(() => [])
  let removed = 0
  for (const name of names) {
    if (!PART_FILE.test(name)) continue
    const file = join(dir, name)
    try {
      const info = await lstat(file)
      if (!info.isFile() || Date.now() - info.mtimeMs < PART_STALE_MS) continue
      await unlink(file)
      removed++
    } catch {
      // gone meanwhile or not ours to delete
    }
  }
  return removed
}

/** lexical check: `child` lies strictly inside `parent` (both are normalised first) */
export function isPathInside(child: string, parent: string): boolean {
  if (!isAbsolute(child) || !isAbsolute(parent)) return false
  const rel = relative(normalize(parent), normalize(child))
  return rel !== '' && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)
}
