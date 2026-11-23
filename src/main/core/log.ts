// Main-process logging: console + <userData>/logs/main.log (size-rotated). Secrets never reach a sink.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Logger {
  info(scope: string, message: string, data?: unknown): void
  warn(scope: string, message: string, data?: unknown): void
  error(scope: string, message: string, data?: unknown): void
}

export type LogLevel = 'info' | 'warn' | 'error'

export interface AppLoggerOptions {
  console?: boolean
  /** rotate once the file would grow beyond this size (default ~5 MB) */
  maxBytes?: number
  /** after a failed write (e.g. a full disk) the file is tried again after this pause (default 30 s) */
  fileRetryMs?: number
  now?: () => Date
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_FILE_RETRY_MS = 30_000
const MAX_STRING = 4000
const REDACTED = '[redacted]'
/** Google API keys ("AIza" + 35 chars); matched generously so truncated keys are caught too */
const GOOGLE_KEY_PATTERN = /AIza[0-9A-Za-z_-]{16,}/g
/** object keys whose values are never logged (note: `promptTokens` & co. are fine) */
const SENSITIVE_KEY_PATTERN =
  /^(api[-_]?key|key|secret|password|authorization|x-goog-api-key|(access|refresh)?[-_]?token)$/i

export class AppLogger implements Logger {
  private file: string | null = null
  private size = 0
  /** a write failed: the file is left alone until then (ms since the epoch) */
  private pausedUntil = 0
  /** lines that did not reach the file while it was paused */
  private dropped = 0
  private readonly secrets = new Set<string>()
  private readonly options: Required<AppLoggerOptions>

  constructor(options: AppLoggerOptions = {}) {
    this.options = {
      console: options.console ?? true,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      fileRetryMs: options.fileRetryMs ?? DEFAULT_FILE_RETRY_MS,
      now: options.now ?? (() => new Date())
    }
  }

  /** starts appending to `file` (created on demand); earlier lines only went to the console */
  attachFile(file: string): void {
    mkdirSync(dirname(file), { recursive: true })
    this.file = file
    try {
      this.size = statSync(file).size
    } catch {
      this.size = 0
    }
  }

  /** every later occurrence of `secret` in a log line is replaced (e.g. the Gemini API key) */
  addSecret(secret: string): void {
    if (secret.length >= 6) this.secrets.add(secret)
  }

  info(scope: string, message: string, data?: unknown): void {
    this.write('info', scope, message, data)
  }

  warn(scope: string, message: string, data?: unknown): void {
    this.write('warn', scope, message, data)
  }

  error(scope: string, message: string, data?: unknown): void {
    this.write('error', scope, message, data)
  }

  /** the line exactly as it would be written (exposed for tests) */
  format(level: LogLevel, scope: string, message: string, data?: unknown): string {
    const head = `${this.options.now().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`
    const line = data === undefined ? head : `${head} ${serialize(data)}`
    return this.redact(line)
  }

  private write(level: LogLevel, scope: string, message: string, data?: unknown): void {
    let line: string
    try {
      line = this.format(level, scope, message, data)
    } catch {
      line = this.redact(`${level.toUpperCase()} [${scope}] ${message} (data not serialisable)`)
    }
    if (this.options.console) {
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
    }
    if (this.file) this.append(this.file, line + '\n')
  }

  private append(file: string, text: string): void {
    const now = this.options.now()
    if (now.getTime() < this.pausedUntil) {
      this.dropped++
      return
    }
    try {
      if (this.dropped > 0) {
        const note = this.redact(
          `${now.toISOString()} WARN  [log] ${this.dropped} line(s) could not be written to the log file\n`
        )
        this.appendRotating(file, note)
        this.dropped = 0
      }
      this.appendRotating(file, text)
    } catch (err) {
      // never let logging take the app down: continue console-only for a while, then try again
      // (a full disk gets space again, and the log must cover what happens then)
      if (this.options.console && this.pausedUntil === 0) {
        console.error('[log] writing the log file failed – paused:', err)
      }
      this.pausedUntil = now.getTime() + this.options.fileRetryMs
      this.dropped++
      return
    }
    this.pausedUntil = 0
  }

  private appendRotating(file: string, text: string): void {
    const bytes = Buffer.byteLength(text)
    if (this.size > 0 && this.size + bytes > this.options.maxBytes) {
      renameSync(file, rotatedName(file))
      this.size = 0
    }
    appendFileSync(file, text)
    this.size += bytes
  }

  private redact(text: string): string {
    let out = text.replace(GOOGLE_KEY_PATTERN, REDACTED)
    for (const secret of this.secrets) out = out.split(secret).join(REDACTED)
    return out
  }
}

export function rotatedName(file: string): string {
  return file.endsWith('.log') ? file.slice(0, -4) + '.1.log' : file + '.1'
}

function errorToJson(err: Error): Record<string, unknown> {
  const extra = err as Error & { code?: unknown; details?: unknown; cause?: unknown }
  return {
    name: err.name,
    message: err.message,
    ...(extra.code !== undefined ? { code: extra.code } : {}),
    ...(extra.details !== undefined ? { details: extra.details } : {}),
    ...(err.stack ? { stack: err.stack.split('\n').slice(0, 8).join('\n') } : {}),
    ...(extra.cause !== undefined ? { cause: extra.cause } : {})
  }
}

export function serialize(data: unknown): string {
  const seen = new WeakSet<object>()
  const json = JSON.stringify(data, function replacer(key: string, value: unknown) {
    if (key !== '' && SENSITIVE_KEY_PATTERN.test(key)) return REDACTED
    if (value instanceof Error) return errorToJson(value)
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'string' && value.length > MAX_STRING) {
      return value.slice(0, MAX_STRING) + '…'
    }
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) return '[circular]'
      seen.add(value)
    }
    return value
  })
  return json ?? String(data)
}

/** process-wide logger; index.ts attaches the log file once userData is known */
export const log = new AppLogger()
