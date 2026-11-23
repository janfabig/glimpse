import { dirname } from 'node:path'
import { MediaError } from '../contracts'

/** User-facing messages of the media module */
export const MESSAGES = {
  // Development only (the packaged app carries its own ffmpeg, see damagedApp). The renderer shows
  // the command at the end as a code block (lib/system.ts).
  noFfmpeg: 'ffmpeg was not found. In the project folder, run: node scripts/fetch-ffmpeg.mjs',
  brokenFfmpeg:
    'ffmpeg was found but does not start. In the project folder, run: node scripts/fetch-ffmpeg.mjs',
  /** the packaged app: its own ffmpeg (Contents/Resources/ffmpeg) is missing or does not start */
  damagedApp:
    'Glimpse is damaged: the ffmpeg inside the app is missing or does not start. ' +
    'Replace the app with a fresh copy of Glimpse.',
  /** ffmpeg was there at the start (it is looked up once) and could not be started later */
  ffmpegNotStarted: 'ffmpeg could not be started. Quit Glimpse and open it again.',
  cancelled: 'Cancelled.',
  unreadable: 'The file could not be read. Is it a supported video?',
  noVideoStream: 'The file has no video track.',
  noDuration: 'The length of the video could not be determined.',
  poster: 'The thumbnail could not be created.',
  proxy: 'The preview of the video could not be created.',
  sprite: 'The filmstrip could not be created.',
  analysisCopy: 'The copy of the video for Gemini could not be created.',
  noClips: 'No clips are selected.',
  join: 'The clips could not be joined. Try again or choose another transition when you export.',
  verify: 'The finished video could not be checked.',
  save:
    'The video could not be saved. Check that the export folder can still be reached and try ' +
    'again.',
  diskFull: 'There is not enough free space on your Mac. Free up some space and try again.',
  /** the export folder is full and on another volume than the work files (an external drive) */
  outputFolderFull: (folder: string): string =>
    `There is not enough free space in the export folder “${folder}”. Free up space there or ` +
    'choose another export folder when you export.',
  invalidSize: 'Invalid video size.',
  invalidPath: 'The file path contains invalid characters.',
  clipFailed: (index: number, count: number): string =>
    `Clip ${index + 1} of ${count} could not be rendered. Try again or remove the clip from ` +
    'the highlight video.',
  invalidClip: (index: number): string => `Clip ${index + 1} has an invalid length.`,
  missingFile: (fileName: string): string => `The file “${fileName}” was not found.`,
  unreadableFile: (fileName: string): string =>
    `The file “${fileName}” could not be read. Is it a supported video?`,
  outputNotWritable: (folder: string): string =>
    `The export folder “${folder}” cannot be written to. Choose another folder.`,
  writeDenied: (folder: string): string =>
    `Glimpse is not allowed to write to the folder “${folder}”. Check the folder’s permissions ` +
    'or choose another one.',
  readDenied: (folder: string): string =>
    `Glimpse is not allowed to access the folder “${folder}”. Check the permissions or allow ` +
    'access in System Settings under “Privacy & Security”.'
} as const

export function cancelledError(): MediaError {
  return new MediaError('cancelled', MESSAGES.cancelled)
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError()
}

// Failures the user can fix outside the app: a full disk or a missing permission. Retrying with
// another encoder cannot help with these, and the generic "could not be rendered" hides the cause.
// strerror(EDQUOT) reads "Disc quota exceeded" on macOS, "Disk quota exceeded" elsewhere.
const DISK_FULL = /No space left on device|Dis[ck] quota exceeded/i
const DENIED = /Permission denied|Operation not permitted|Read-only file system/i
const DISK_FULL_CODES = new Set(['ENOSPC', 'EDQUOT'])
const DENIED_CODES = new Set(['EACCES', 'EPERM', 'EROFS'])

/** the files of an ffmpeg/ffprobe run: `-i` values and (ffmpeg) the output, the last argument */
export interface ProcessFiles {
  inputs: readonly string[]
  output?: string
}

/** inputs and output of an ffmpeg argument list (every run here ends with its output file) */
export function filesOfArgs(args: readonly string[]): ProcessFiles {
  const inputs = args.flatMap((arg, i) =>
    arg === '-i' && i + 1 < args.length ? [args[i + 1]] : []
  )
  const output = args.at(-1)
  return {
    inputs,
    output: output && output !== '-' && !inputs.includes(output) ? output : undefined
  }
}

/**
 * Message for a full disk or a missing permission in ffmpeg/ffprobe's error output, naming
 * the folder; null for every other failure.
 */
export function environmentFailure(stderr: string, files: ProcessFiles): string | null {
  if (DISK_FULL.test(stderr)) return MESSAGES.diskFull
  if (!DENIED.test(stderr)) return null
  const readDenied = (path: string | undefined): string | null =>
    path ? MESSAGES.readDenied(dirname(path)) : null
  const writeDenied = (path: string | undefined): string | null =>
    path ? MESSAGES.writeDenied(dirname(path)) : null
  if (/Error opening output/i.test(stderr)) {
    return writeDenied(/^Error opening output file (.+)\.$/m.exec(stderr)?.[1] ?? files.output)
  }
  const opened =
    /Impossible to open '(.+)'/.exec(stderr)?.[1] ??
    /^Error opening input file (.+)\.$/m.exec(stderr)?.[1]
  if (opened) return readDenied(opened)
  const deniedLine = stderr.split(/\r?\n/).find((line) => DENIED.test(line)) ?? ''
  const input = files.inputs.find((path) => deniedLine.includes(path))
  if (input) return readDenied(input)
  return files.output ? writeDenied(files.output) : readDenied(files.inputs[0])
}

/** the same for a failed file-system call (Node errno) on `path` */
export function fsFailure(err: unknown, path: string, side: 'read' | 'write'): string | null {
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (code === undefined) return null
  if (DISK_FULL_CODES.has(code)) return MESSAGES.diskFull
  if (!DENIED_CODES.has(code)) return null
  return side === 'write' ? MESSAGES.writeDenied(path) : MESSAGES.readDenied(path)
}

/**
 * true for errors that no other encoder or decoder can avoid (full disk, missing permission):
 * fallbacks are skipped for them
 */
export function isEnvironmentFailure(err: unknown): boolean {
  if (!(err instanceof MediaError)) return false
  return (
    err.message === MESSAGES.diskFull ||
    (err.code === 'ffmpeg' && (DISK_FULL.test(err.details ?? '') || DENIED.test(err.details ?? '')))
  )
}

/** Last `maxLines` non-empty lines of a log text, capped at `maxChars` (keeps the end). */
export function tailLines(text: string, maxLines = 20, maxChars = 4000): string {
  const lines = text
    .split(/\r?\n|\r/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
  const tail = lines.slice(-maxLines).join('\n')
  return tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail
}
