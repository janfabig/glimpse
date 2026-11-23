import { spawn } from 'node:child_process'
import type { ProgressFn } from '../contracts'
import { MediaError } from '../contracts'
import { cancelledError, environmentFailure, filesOfArgs, MESSAGES, tailLines } from './errors'
import { createProgressParser, progressFraction } from './progress'

const STDERR_KEEP_CHARS = 64 * 1024
const STDOUT_MAX_CHARS = 16 * 1024 * 1024
const DEFAULT_KILL_GRACE_MS = 2000
const TIMEOUT_TICK_MS = 1000

export interface ProcessOptions {
  signal?: AbortSignal
  /** keep stdout in the result (ffprobe JSON, version output) */
  captureStdout?: boolean
  onStdout?: (chunk: string) => void
  /** receives the child pid right after spawning (tests, diagnostics) */
  onSpawn?: (pid: number) => void
  /** SIGKILL the process after this many ms; the result then has `timedOut: true` */
  timeoutMs?: number
  /** delay between SIGTERM and SIGKILL after an abort */
  killGraceMs?: number
}

export interface ProcessResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  /** tail of stderr (last 64 KiB) */
  stderr: string
  timedOut: boolean
}

/**
 * Spawns a process and resolves when it has exited (any exit code). Rejects with
 * MediaError('cancelled') after an abort – only once the process is really gone, so callers can
 * safely delete its output files – and with MediaError('no-ffmpeg') when it cannot be started.
 */
export function runProcess(
  bin: string,
  args: readonly string[],
  options: ProcessOptions = {}
): Promise<ProcessResult> {
  const { signal } = options
  return new Promise<ProcessResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError())
      return
    }
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let aborted = false
    let timedOut = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    let timeoutTimer: NodeJS.Timeout | undefined

    const onAbort = (): void => {
      if (aborted) return
      aborted = true
      child.kill('SIGTERM')
      killTimer = setTimeout(
        () => child.kill('SIGKILL'),
        options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
      )
    }
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
      clearTimeout(killTimer)
      clearInterval(timeoutTimer)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    if (options.timeoutMs !== undefined) {
      // counted in ticks, not as one long timer: the process stands still while the Mac sleeps, a
      // timer does not – after a night with the lid closed one tick is gone, not the whole limit
      const tickMs = Math.max(1, Math.min(options.timeoutMs, TIMEOUT_TICK_MS))
      let ticksLeft = Math.ceil(options.timeoutMs / tickMs)
      timeoutTimer = setInterval(() => {
        if (--ticksLeft > 0) return
        timedOut = true
        child.kill('SIGKILL')
      }, tickMs)
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (options.captureStdout && stdout.length < STDOUT_MAX_CHARS) stdout += chunk
      options.onStdout?.(chunk)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > STDERR_KEEP_CHARS) stderr = stderr.slice(-STDERR_KEEP_CHARS)
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new MediaError('no-ffmpeg', MESSAGES.ffmpegNotStarted, `${bin}: ${err.message}`))
    })
    child.on('close', (code, exitSignal) => {
      if (settled) return
      settled = true
      cleanup()
      if (aborted) reject(cancelledError())
      else resolve({ code, signal: exitSignal, stdout, stderr, timedOut })
    })

    if (child.pid !== undefined) options.onSpawn?.(child.pid)
  })
}

export interface FfmpegRunOptions {
  /**
   * User-facing message used when ffmpeg exits with an error – unless the cause is a full
   * disk or a missing permission, which get their own message (see environmentFailure)
   */
  errorMessage: string
  /** expected duration of the output (seconds), for progress fractions */
  durationSec?: number
  onProgress?: ProgressFn
  signal?: AbortSignal
  onSpawn?: (pid: number) => void
  /** ffmpeg is killed after this many ms and the run fails with `errorMessage` (a hung run ends) */
  timeoutMs?: number
}

/** Standard flags for every ffmpeg run: quiet stderr, machine-readable progress on stdout. */
const FFMPEG_BASE_ARGS = [
  '-hide_banner',
  '-nostdin',
  '-y',
  '-loglevel',
  'warning',
  '-progress',
  'pipe:1',
  '-nostats'
] as const

export async function runFfmpeg(
  ffmpegPath: string,
  args: readonly string[],
  options: FfmpegRunOptions
): Promise<void> {
  const { onProgress, durationSec } = options
  const parse = createProgressParser(({ outTimeSec }) => {
    if (!onProgress) return
    const fraction = progressFraction(outTimeSec, durationSec)
    if (fraction >= 0 || durationSec === undefined) onProgress(fraction)
  })
  const result = await runProcess(ffmpegPath, [...FFMPEG_BASE_ARGS, ...args], {
    signal: options.signal,
    onStdout: parse,
    onSpawn: options.onSpawn,
    timeoutMs: options.timeoutMs
  })
  if (result.code !== 0) {
    const details = result.timedOut
      ? `ffmpeg timed out after ${options.timeoutMs} ms`
      : tailLines(result.stderr) || `ffmpeg exited with ${result.code ?? result.signal}`
    const message = environmentFailure(result.stderr, filesOfArgs(args)) ?? options.errorMessage
    throw new MediaError('ffmpeg', message, details)
  }
  onProgress?.(1)
}
