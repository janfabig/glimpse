import { randomBytes } from 'node:crypto'
import { link, lstat, mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { MediaError } from '../contracts'
import { fsFailure, MESSAGES } from './errors'

/**
 * Hidden sibling of `finalPath` with the same extension (so ffmpeg still picks the right muxer),
 * e.g. `/out/My Reel.mp4` → `/out/.My Reel.3fa2c1d0.part.mp4`.
 */
export function tempSiblingPath(finalPath: string): string {
  const ext = extname(finalPath)
  const name = basename(finalPath, ext)
  return join(dirname(finalPath), `.${name}.${randomBytes(4).toString('hex')}.part${ext}`)
}

/** creates `dir`; a full disk or a missing permission becomes a MediaError with a message for the user */
export async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    const message = fsFailure(err, dir, 'write')
    if (message === null) throw err
    throw new MediaError('ffmpeg', message, String(err))
  }
}

export async function removeQuietly(filePath: string): Promise<void> {
  await rm(filePath, { force: true }).catch(() => undefined)
}

export async function fileSize(filePath: string): Promise<number> {
  try {
    const info = await stat(filePath)
    return info.isFile() ? info.size : 0
  } catch {
    return 0
  }
}

/** the next name in the " (2)", " (3)", … series: "Reel.mp4" → "Reel (2).mp4" → "Reel (3).mp4" */
export function nextFreeName(path: string): string {
  const ext = extname(path)
  const stem = basename(path, ext)
  const numbered = /^(.*) \((\d+)\)$/.exec(stem)
  const [base, n] = numbered ? [numbered[1], Number(numbered[2]) + 1] : [stem, 2]
  return join(dirname(path), `${base} (${n})${ext}`)
}

async function pathTaken(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (err: NodeJS.ErrnoException) => err.code !== 'ENOENT'
  )
}

/** link() errors of file systems without hard links (exFAT/FAT, some network shares) */
const NO_HARD_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK', 'EXDEV', 'EPERM'])
const MAX_FREE_NAME_TRIES = 1000

/**
 * Moves `tempPath` to `finalPath` without ever replacing a file: a hard link fails with EEXIST
 * when the name is taken by the file system's own rules (on APFS also in another case or Unicode
 * normalisation), then the next name of the series is tried. File systems without hard links fall
 * back to check-then-rename. Returns the path used.
 */
export async function moveToFreeName(tempPath: string, finalPath: string): Promise<string> {
  let candidate = finalPath
  for (let i = 0; i < MAX_FREE_NAME_TRIES; i++, candidate = nextFreeName(candidate)) {
    try {
      await link(tempPath, candidate)
      await removeQuietly(tempPath)
      return candidate
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (code === 'EEXIST') continue
      if (!NO_HARD_LINKS.has(code)) throw err
      if (await pathTaken(candidate)) continue
      await rename(tempPath, candidate)
      return candidate
    }
  }
  throw new Error(`no free name for ${finalPath}`)
}

/**
 * Runs `produce(tempPath)` and atomically moves the result to `finalPath`. The temp file is
 * removed when `produce` (or the rename) throws; `produce` rejects empty output where it matters.
 */
export async function writeAtomically<T>(
  finalPath: string,
  produce: (tempPath: string) => Promise<T>
): Promise<T> {
  return (await writeFileVia(finalPath, produce, 'replace')).result
}

/**
 * writeAtomically for files the user keeps (exports): an existing file is never replaced, the
 * result gets the next free name instead (see moveToFreeName). Returns the path used.
 */
export async function writeNewFile<T>(
  finalPath: string,
  produce: (tempPath: string) => Promise<T>
): Promise<{ result: T; path: string }> {
  return writeFileVia(finalPath, produce, 'keep-existing')
}

/** true when both paths live on the same volume (also when that cannot be told) */
export async function sameVolume(a: string, b: string): Promise<boolean> {
  try {
    const [first, second] = await Promise.all([stat(a), stat(b)])
    return first.dev === second.dev
  } catch {
    return true
  }
}

/**
 * Runs `write`, which writes `outputPath` (the final export). A full disk there is named when the
 * export folder lies on another volume than `workDir` (the app's data) – e.g. an external drive:
 * "your Mac is full" would send the user to free space where it does not help.
 */
export async function namingFullOutputFolder<T>(
  outputPath: string,
  workDir: string,
  write: () => Promise<T>
): Promise<T> {
  try {
    return await write()
  } catch (err) {
    if (!(err instanceof MediaError) || err.message !== MESSAGES.diskFull) throw err
    const folder = dirname(outputPath)
    if (await sameVolume(folder, workDir)) throw err
    throw new MediaError(err.code, MESSAGES.outputFolderFull(folder), err.details)
  }
}

async function writeFileVia<T>(
  finalPath: string,
  produce: (tempPath: string) => Promise<T>,
  mode: 'replace' | 'keep-existing'
): Promise<{ result: T; path: string }> {
  await ensureDir(dirname(finalPath))
  const tempPath = tempSiblingPath(finalPath)
  try {
    const result = await produce(tempPath)
    const move =
      mode === 'replace'
        ? rename(tempPath, finalPath).then(() => finalPath)
        : moveToFreeName(tempPath, finalPath)
    const path = await move.catch((err: unknown) => {
      const message = fsFailure(err, dirname(finalPath), 'write') ?? MESSAGES.save
      throw new MediaError('ffmpeg', message, String(err))
    })
    return { result, path }
  } catch (err) {
    await removeQuietly(tempPath)
    throw err
  }
}
