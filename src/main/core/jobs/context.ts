// Shared plumbing of the background jobs (prepare, analysis, export).

import type { AppSettings, ExportProgress, Project, ToastEvent, VideoInfo } from '@shared/types'
import type { Analyzer, MediaService } from '../../contracts'
import { fail } from '../errors'
import type { Logger } from '../log'
import type { AppPaths } from '../paths'
import { PROJECT_NOT_FOUND, type ProjectStore, type UpdateOptions } from '../project/store'
import type { DiskSpace } from './diskSpace'

export interface SettingsSource {
  getAppSettings(): AppSettings
  getApiKey(): Promise<string | null>
  /**
   * Google accepted or rejected this key during an analysis: a rejected stored key shows as
   * "API key rejected" in the settings instead of "Connected" (AppSettings.apiKeyRejected)
   */
  reportKeyCheck?(apiKey: string, accepted: boolean): void
}

export interface JobNotifier {
  toast(event: ToastEvent): void
  exportProgress(event: ExportProgress): void
  /**
   * delivers the latest state of the project to the renderer now instead of after the update
   * throttle – before a toast or event that refers to it, or before an IPC call resolves
   */
  flushProject(projectId: string): void
}

export interface JobContext {
  store: ProjectStore
  settings: SettingsSource
  media: MediaService
  analyzer: Analyzer
  paths: AppPaths
  notify: JobNotifier
  log: Logger
  disk: DiskSpace
  /** RAM of this Mac in bytes: decides how much the exports may render at once */
  memoryBytes: number
  now: () => Date
  newId: () => string
  tasks: TaskTracker
  /** true from the start of a project's deletion until it is gone: no new work may start for it */
  isDeleting(projectId: string): boolean
}

type LiveCheck = Pick<JobContext, 'store' | 'isDeleting'>

/** false once the project is gone or its deletion has started */
export function isLive(ctx: LiveCheck, projectId: string): boolean {
  return !ctx.isDeleting(projectId) && ctx.store.find(projectId) !== undefined
}

/** the project; not-found when it is unknown or being deleted */
export function requireLiveProject(ctx: LiveCheck, projectId: string): Project {
  if (ctx.isDeleting(projectId)) fail('not-found', PROJECT_NOT_FOUND)
  return ctx.store.get(projectId)
}

/** Remembers running background promises so shutdown and deletes can wait for them. */
export class TaskTracker {
  private readonly tasks = new Set<{ projectId: string; promise: Promise<unknown> }>()
  /** true when the first task starts, false when the last one ends */
  private readonly onBusyChange?: (busy: boolean) => void

  constructor(onBusyChange?: (busy: boolean) => void) {
    this.onBusyChange = onBusyChange
  }

  track<T>(projectId: string, promise: Promise<T>): Promise<T> {
    const entry = { projectId, promise }
    this.tasks.add(entry)
    if (this.tasks.size === 1) this.onBusyChange?.(true)
    const done = (): void => {
      this.tasks.delete(entry)
      if (this.tasks.size === 0) this.onBusyChange?.(false)
    }
    promise.then(done, done)
    return promise
  }

  /** resolves once no task (of the project) is left – including tasks started meanwhile */
  async settled(projectId?: string): Promise<void> {
    for (;;) {
      const pending = [...this.tasks]
        .filter((task) => projectId === undefined || task.projectId === projectId)
        .map((task) => task.promise)
      if (pending.length === 0) return
      await Promise.allSettled(pending)
    }
  }
}

/** resolves with false when `promise` takes longer than `ms` (it keeps running) */
export function withTimeout(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  return Promise.race([
    promise.then(
      () => true,
      () => true
    ),
    timeout
  ]).finally(() => clearTimeout(timer))
}

/** rejects with an AbortError as soon as `signal` aborts */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // nobody waits for `promise` any more: its later failure must not become an unhandled rejection
    promise.catch(() => undefined)
    return Promise.reject(abortError())
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}

export function abortError(): Error {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

export function findVideo(project: Project | undefined, videoId: string): VideoInfo | undefined {
  return project?.videos.find((video) => video.id === videoId)
}

/** updates the project only while the video still exists (jobs may outlive a removal) */
export function updateVideo(
  ctx: Pick<JobContext, 'store'>,
  projectId: string,
  videoId: string,
  recipe: (draft: Project, video: VideoInfo) => void,
  options?: UpdateOptions
): Project | null {
  if (!findVideo(ctx.store.find(projectId), videoId)) return null
  return ctx.store.update(
    projectId,
    (draft) => {
      const video = findVideo(draft, videoId)
      if (video) recipe(draft, video)
    },
    options
  )
}

/** progress callback that drops updates arriving faster than `intervalMs` (except completion) */
export function throttledProgress(
  apply: (fraction: number) => void,
  intervalMs = 250,
  now: () => number = Date.now
): (fraction: number) => void {
  let lastAt = Number.NEGATIVE_INFINITY
  let last = -1
  return (fraction) => {
    if (!Number.isFinite(fraction) || fraction < 0) return
    const t = now()
    if (fraction < 1 && (t - lastAt < intervalMs || Math.abs(fraction - last) < 0.005)) return
    lastAt = t
    last = fraction
    apply(Math.min(1, fraction))
  }
}

/** like Array.map, with at most `limit` promises in flight */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
