// Uploads on Google's side (Gemini Files API) are private data: they leave with their video or
// project, and replaced or orphaned ones are deleted right away (best effort). Deletes – core's
// own and the analyzer's background cleanup – are tracked, so quitting the app waits for them
// (within the shutdown timeout).

import type { RemoteFileRef } from '@shared/types'
import { withTimeout, type JobContext } from './context'

/** TaskTracker key of the deletes: they belong to no project's jobs (a project delete need not wait) */
const REMOTE_DELETES = 'remote-files'
const DELETE_TIMEOUT_MS = 30_000

/** true while a project still refers to the upload (the analyzer can share one per proxy) */
function inUse(ctx: Pick<JobContext, 'store'>, name: string): boolean {
  return ctx.store
    .all()
    .some((project) => Object.values(project.remoteFiles).some((file) => file.name === name))
}

/**
 * Deletes the upload in the background. `apiKey`: the key that uploaded it, when known (an
 * analysis run); otherwise the current key is used.
 */
export function deleteRemoteFile(
  ctx: JobContext,
  projectId: string,
  file: RemoteFileRef,
  apiKey?: string
): void {
  if (inUse(ctx, file.name)) return
  const task = (async () => {
    const key = apiKey || (await ctx.settings.getApiKey())
    if (!key && !ctx.settings.getAppSettings().fakeAi) {
      ctx.log.warn('jobs', 'remote file not deleted – no API key', { projectId, name: file.name })
      return
    }
    await ctx.analyzer.deleteRemoteFile(key ?? '', file.name)
  })().catch((err: unknown) =>
    ctx.log.warn('jobs', 'remote file not deleted', { projectId, name: file.name, err })
  )
  trackRemoteCleanup(ctx, task)
}

/**
 * Background work on Google's side that nobody awaits – core's own deletes, and the analyzer's
 * cleanup it hands over (AnalyzeRequest.onCleanup: an upload Gemini was still processing when the
 * analysis was cancelled, an orphaned upload): quitting waits for it within the shutdown timeout.
 */
export function trackRemoteCleanup(ctx: Pick<JobContext, 'tasks'>, cleanup: Promise<void>): void {
  void ctx.tasks.track(REMOTE_DELETES, withTimeout(cleanup, DELETE_TIMEOUT_MS))
}

export function sameRemoteFile(a: RemoteFileRef, b: RemoteFileRef): boolean {
  return (
    a.name === b.name &&
    a.uri === b.uri &&
    a.mimeType === b.mimeType &&
    a.expiresAt === b.expiresAt &&
    a.proxyFingerprint === b.proxyFingerprint
  )
}
