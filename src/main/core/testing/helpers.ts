// Generic helpers for core tests (temp dirs, deferred promises, recording logger).

import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '../log'
import { serialize } from '../log'

export interface TempDir {
  path: string
  cleanup(): Promise<void>
}

export async function makeTempDir(prefix = 'hc-core-'): Promise<TempDir> {
  // realpath: macOS tmpdir is a symlink (/var → /private/var)
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) }
}

export { deferred, type Deferred } from '../deferred'

export interface LogEntry {
  level: 'info' | 'warn' | 'error'
  scope: string
  message: string
  data?: unknown
}

export interface RecordingLogger extends Logger {
  entries: LogEntry[]
  /** every entry as one serialised line (to assert that secrets never show up) */
  text(): string
}

export function recordingLogger(): RecordingLogger {
  const entries: LogEntry[] = []
  const push =
    (level: LogEntry['level']) =>
    (scope: string, message: string, data?: unknown): void => {
      entries.push({ level, scope, message, data })
    }
  return {
    entries,
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    text: () =>
      entries
        .map(
          (e) =>
            `${e.level} [${e.scope}] ${e.message} ${e.data === undefined ? '' : serialize(e.data)}`
        )
        .join('\n')
  }
}

/** polls `check` until it stops throwing (or the timeout hits) */
export async function eventually(
  check: () => void | Promise<void>,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await check()
      return
    } catch (err) {
      if (Date.now() > deadline) throw err
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
}
