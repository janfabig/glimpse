// Errors that cross the IPC boundary. The renderer decodes them with parseIpcError().

import {
  encodeIpcError,
  IPC_ERROR_PREFIX,
  type IpcErrorCode,
  type IpcErrorPayload
} from '@shared/ipc'
import { AnalyzerError, MediaError } from '../contracts'

/** An expected, user-facing error: `message` is the encoded IPC payload, `userMessage` is for the user. */
export class CoreError extends Error {
  readonly code: IpcErrorCode
  readonly userMessage: string

  constructor(code: IpcErrorCode, userMessage: string, options?: { cause?: unknown }) {
    super(encodeIpcError({ code, message: userMessage }), options)
    this.name = 'CoreError'
    this.code = code
    this.userMessage = userMessage
  }
}

export function fail(code: IpcErrorCode, message: string): never {
  throw new CoreError(code, message)
}

/** where users find the log (Settings → System has a button that reveals it in Finder) */
export const LOG_HINT = 'You can find details in Settings under System → Log file.'

export const INTERNAL_ERROR_MESSAGE = `Something went wrong. ${LOG_HINT}`

export const DISK_FULL_MESSAGE =
  'There is not enough free space on your Mac. Free up some space and try again.'

/**
 * The export folder is full and lies on another volume than the app's data (e.g. an external SSD):
 * space on the Mac would not help. Media uses the same text (MESSAGES.outputFolderFull).
 */
export function folderFullMessage(folder: string): string {
  return (
    `There is not enough free space in the export folder “${folder}”. Free up space there or ` +
    'choose another export folder when you export.'
  )
}

const FOLDER_FULL = /^There is not enough free space in the export folder “.+”\./s

const DISK_FULL_CODES: ReadonlySet<string> = new Set(['ENOSPC', 'EDQUOT'])
/**
 * ffmpeg's stderr (MediaError.details) when the target volume is full; strerror(EDQUOT) is "Disc
 * quota exceeded" on macOS and "Disk quota exceeded" elsewhere
 */
const DISK_FULL_OUTPUT = /No space left on device|Dis[ck] quota exceeded/i

/** true for "the disk is full" from the file system (errno) or from ffmpeg (stderr), also as a cause */
export function isDiskFull(err: unknown): boolean {
  let current: unknown = err
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth++) {
    const { code, details } = current as { code?: unknown; details?: unknown }
    if (typeof code === 'string' && DISK_FULL_CODES.has(code)) return true
    if (typeof details === 'string' && DISK_FULL_OUTPUT.test(details)) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

export function isMediaError(err: unknown): err is MediaError {
  return err instanceof MediaError || (err instanceof Error && err.name === 'MediaError')
}

export function isAnalyzerError(err: unknown): err is AnalyzerError {
  return err instanceof AnalyzerError || (err instanceof Error && err.name === 'AnalyzerError')
}

/** true for every flavour of "the user (or shutdown) cancelled this" */
export function isCancellation(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (isMediaError(err) || isAnalyzerError(err)) return err.code === 'cancelled'
  return err instanceof Error && err.name === 'AbortError'
}

/**
 * User-facing text for an error from our own modules. MediaError, AnalyzerError and
 * CoreError messages are written for users and are passed through unchanged.
 */
export function userMessage(err: unknown, fallback: string): string {
  if (err instanceof CoreError) return err.userMessage
  if (isDiskFull(err)) {
    // media names the export folder when that one is full (not the Mac's own volume)
    return isMediaError(err) && FOLDER_FULL.test(err.message) ? err.message : DISK_FULL_MESSAGE
  }
  if ((isMediaError(err) || isAnalyzerError(err)) && err.message.trim() !== '') return err.message
  return fallback
}

export interface MappedIpcError {
  payload: IpcErrorPayload
  /** false → a bug or an unexpected environment problem that should be logged with its stack */
  expected: boolean
}

/** Maps anything thrown inside a handler to the payload the renderer receives. */
export function toIpcPayload(err: unknown): MappedIpcError {
  if (err instanceof CoreError) {
    return { payload: { code: err.code, message: err.userMessage }, expected: true }
  }
  // e.g. a raw ENOSPC from writing a project or the settings: logged in full, told plainly
  if (isDiskFull(err)) {
    return { payload: { code: 'internal', message: DISK_FULL_MESSAGE }, expected: false }
  }
  if (isMediaError(err)) {
    const code: IpcErrorCode =
      err.code === 'no-ffmpeg' ? 'no-ffmpeg' : err.code === 'invalid' ? 'invalid' : 'internal'
    return { payload: { code, message: err.message }, expected: true }
  }
  if (isAnalyzerError(err)) {
    const code: IpcErrorCode = err.code === 'auth' ? 'no-api-key' : 'internal'
    return { payload: { code, message: err.message }, expected: true }
  }
  if (err instanceof Error) {
    const index = err.message.indexOf(IPC_ERROR_PREFIX)
    if (index >= 0) {
      try {
        const parsed = JSON.parse(
          err.message.slice(index + IPC_ERROR_PREFIX.length)
        ) as IpcErrorPayload
        if (typeof parsed?.code === 'string' && typeof parsed.message === 'string') {
          return { payload: parsed, expected: true }
        }
      } catch {
        // not one of ours
      }
    }
  }
  return { payload: { code: 'internal', message: INTERNAL_ERROR_MESSAGE }, expected: false }
}
