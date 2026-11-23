// addVideos: probe + fingerprint + poster for every file (folders the user handed over: the videos
// inside), then insert chronologically.

import { VIDEO_EXTENSIONS } from '@shared/presets'
import type { AddVideosResult, VideoInfo } from '@shared/types'
import type { Stats } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, normalize } from 'node:path'
import { fail, userMessage } from '../errors'
import { removePath } from '../fsx'
import { initialVideoStatus } from '../project/defaults'
import { compareVideos } from '../project/order'
import { PROJECT_NOT_FOUND } from '../project/store'
import { isLive, mapLimit, requireLiveProject, type JobContext } from './context'
import { JOB_MESSAGES } from './messages'
import { posterTime } from './prepare'

const PROBE_CONCURRENCY = 3

type Probed = { path: string; video: VideoInfo } | { path: string; skip: string }

export interface ImportResult extends AddVideosResult {
  addedIds: string[]
}

/** ISO recording time from the file system when the container has none */
function fileTime(info: Stats): string {
  const birth = info.birthtimeMs > 0 ? info.birthtime : info.mtime
  return birth.toISOString()
}

/** never rejects; once the project is being deleted, the remaining files are skipped untouched */
async function probeFile(ctx: JobContext, projectId: string, path: string): Promise<Probed> {
  const gone: Probed = { path, skip: PROJECT_NOT_FOUND }
  if (!isLive(ctx, projectId)) return gone
  let info: Stats
  try {
    info = await stat(path)
  } catch {
    return { path, skip: JOB_MESSAGES.fileMissing }
  }
  // a folder was expanded before; one created since then under a file's name has no videos
  if (info.isDirectory()) return { path, skip: JOB_MESSAGES.folderWithoutVideos }
  if (!info.isFile()) return { path, skip: JOB_MESSAGES.notAVideo }

  const id = ctx.newId()
  try {
    const probe = await ctx.media.probe(path)
    if (!(probe.durationSec > 0)) return { path, skip: JOB_MESSAGES.unreadable }
    const fingerprint = await ctx.media.fingerprint(path)
    // still being copied (Finder, an external drive): size and fingerprint would be those of a part
    // of the file, and the export would refuse the finished file as changed
    const now = await stat(path)
    if (now.size !== info.size || now.mtimeMs !== info.mtimeMs) {
      return { path, skip: JOB_MESSAGES.stillCopying }
    }
    // the poster goes into the project folder – never recreate it after a delete
    if (!isLive(ctx, projectId)) return gone
    const posterPath = ctx.paths.posterFile(projectId, id)
    let poster: string | null = posterPath
    try {
      await mkdir(ctx.paths.videoMediaDir(projectId, id), { recursive: true })
      await ctx.media.makePoster(path, posterPath, posterTime(probe.durationSec))
    } catch (err) {
      ctx.log.warn('import', 'poster failed – continuing without', { path, err })
      poster = null
    }
    const video: VideoInfo = {
      id,
      path,
      fileName: basename(path),
      sizeBytes: probe.sizeBytes > 0 ? probe.sizeBytes : info.size,
      durationSec: probe.durationSec,
      width: probe.width,
      height: probe.height,
      hasAudio: probe.hasAudio,
      recordedAt: probe.recordedAt ?? fileTime(info),
      fingerprint,
      proxyPath: null,
      posterPath: poster,
      spritePath: null,
      spriteInfo: null
    }
    return { path, video }
  } catch (err) {
    ctx.log.warn('import', 'file skipped', { path, err })
    await removePath(ctx.paths.videoMediaDir(projectId, id)).catch(() => undefined)
    return { path, skip: userMessage(err, JOB_MESSAGES.unreadable) }
  }
}

/** size and checksum of a fingerprint (`size-mtimeMs-sha1`): a copy to exFAT/HFS+ or by `cp` gets another mtime */
const contentOf = (fingerprint: string): string =>
  fingerprint.slice(0, fingerprint.indexOf('-')) + fingerprint.slice(fingerprint.lastIndexOf('-'))

const isVideoName = (path: string): boolean =>
  VIDEO_EXTENSIONS.includes(extname(path).slice(1).toLowerCase())

/** natural order, like Finder: "clip2" before "clip10" */
const byName = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

/**
 * The videos directly inside `path` (sorted by name; hidden files and subfolders left out), or null
 * when `path` is no folder.
 */
async function folderVideos(path: string): Promise<string[] | null> {
  try {
    if (!(await stat(path)).isDirectory()) return null
    const entries = await readdir(path, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith('.') && isVideoName(name))
      .sort(byName)
      .map((name) => join(path, name))
  } catch {
    // missing or unreadable: the probe reports it like any other file
    return null
  }
}

/**
 * Adds the files to the project; a folder the user handed over (`handedOver`: picked in the dialog
 * or dragged from Finder) adds the videos directly inside it. A file or folder that was not handed
 * over is never read: a renderer script must not make main open (and then serve) any file it names.
 * Files that are no videos, unreadable or already part of the project (same path or same content)
 * are skipped with a reason for the user.
 */
export async function importVideos(
  ctx: JobContext,
  projectId: string,
  paths: readonly string[],
  handedOver: (path: string) => boolean
): Promise<ImportResult> {
  requireLiveProject(ctx, projectId)
  const ffmpeg = await ctx.media.status()
  if (!ffmpeg.ok) fail('no-ffmpeg', ffmpeg.error ?? JOB_MESSAGES.noFfmpeg)

  const skipped: AddVideosResult['skipped'] = []
  const candidates: string[] = []
  const seen = new Set<string>()
  const known = new Set(requireLiveProject(ctx, projectId).videos.map((v) => normalize(v.path)))
  const consider = (path: string, granted: boolean): void => {
    if (seen.has(path)) return
    seen.add(path)
    // not handed over: the reason a folder gets too, so it tells nothing about the path
    if (!isVideoName(path) || (!granted && !known.has(path))) {
      skipped.push({ path, reason: JOB_MESSAGES.notAVideo })
    } else if (known.has(path)) {
      skipped.push({ path, reason: JOB_MESSAGES.alreadyInProject })
    } else {
      candidates.push(path)
    }
  }
  for (const raw of paths) {
    if (!isAbsolute(raw)) {
      skipped.push({ path: raw, reason: JOB_MESSAGES.invalidPath })
      continue
    }
    const path = normalize(raw)
    const granted = handedOver(path)
    const videos = granted ? await folderVideos(path) : null
    if (videos === null) {
      consider(path, granted)
    } else if (videos.length === 0) {
      if (!seen.has(path)) skipped.push({ path, reason: JOB_MESSAGES.folderWithoutVideos })
      seen.add(path)
    } else {
      for (const video of videos) consider(video, true)
    }
  }

  const probed = await mapLimit(candidates, PROBE_CONCURRENCY, (path) =>
    probeFile(ctx, projectId, path)
  )
  // a video whose original no longer holds its content (moved, copied to another drive, replaced)
  // is linked to an added file with that content instead of skipping it: clips and analysis stay
  const incoming = new Set(
    probed.flatMap((e) =>
      'video' in e && e.video.fingerprint ? [contentOf(e.video.fingerprint)] : []
    )
  )
  const relinkable = new Map<string, string>()
  for (const v of requireLiveProject(ctx, projectId).videos) {
    const content = contentOf(v.fingerprint)
    if (!v.fingerprint || !incoming.has(content) || relinkable.has(content)) continue
    const there = await ctx.media.fingerprint(v.path).then(contentOf, () => '')
    if (there !== content) relinkable.set(content, v.id)
  }
  // deleted meanwhile: the posters written so far go with the project folder
  requireLiveProject(ctx, projectId)
  const added: VideoInfo[] = []
  const relinked: VideoInfo[] = []
  const duplicates: VideoInfo[] = []
  const project = ctx.store.update(projectId, (draft) => {
    for (const entry of probed) {
      if ('skip' in entry) {
        skipped.push({ path: entry.path, reason: entry.skip })
        continue
      }
      const { video } = entry
      const content = contentOf(video.fingerprint)
      const target = draft.videos.find((v) => v.id === relinkable.get(content))
      if (target && !draft.videos.some((v) => normalize(v.path) === video.path)) {
        relinkable.delete(content)
        target.path = video.path
        target.fileName = video.fileName
        target.fingerprint = video.fingerprint
        const status = draft.status[target.id]
        if (status.prepare.status !== 'done') status.prepare = { status: 'pending', progress: 0 }
        relinked.push(target)
        // drops the poster made while probing
        duplicates.push(video)
        continue
      }
      // re-checked here: another import may have finished while this one was probing
      const duplicate = draft.videos.some(
        (v) =>
          normalize(v.path) === video.path ||
          (video.fingerprint !== '' && v.fingerprint === video.fingerprint)
      )
      if (duplicate) {
        skipped.push({ path: video.path, reason: JOB_MESSAGES.alreadyInProject })
        duplicates.push(video)
        continue
      }
      draft.videos.push(video)
      draft.status[video.id] = initialVideoStatus()
      added.push(video)
    }
    draft.videos.sort(compareVideos)
  })

  for (const video of duplicates) {
    await removePath(ctx.paths.videoMediaDir(projectId, video.id)).catch(() => undefined)
  }
  if (added.length > 0 || relinked.length > 0 || skipped.length > 0) {
    ctx.log.info('import', 'videos added', {
      projectId,
      added: added.length,
      relinked: relinked.length,
      skipped: skipped.length
    })
  }
  if (relinked.length > 0) {
    const names = relinked.map((video) => video.fileName)
    ctx.notify.toast({ level: 'success', message: JOB_MESSAGES.relinked(names), projectId })
  }
  // a relinked video whose preview failed is prepared again from its new path
  const toPrepare = [...added, ...relinked].filter(
    (video) => project.status[video.id]?.prepare.status !== 'done'
  )
  return { project, added: added.length, skipped, addedIds: toPrepare.map((video) => video.id) }
}
