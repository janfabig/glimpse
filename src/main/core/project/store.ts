// Owns all projects in memory and persists them as <userData>/projects/<id>/project.json
// (atomic, debounced writes). Every change goes through update() and is announced to subscribers.
// The previous version of every file stays as project.json.bak: a project.json damaged by a crash
// or a power loss is restored from it on the next start.

import { TOAST_KEYS } from '@shared/ipc'
import type { Project, ProjectSummary, ToastEvent } from '@shared/types'
import { constants } from 'node:fs'
import { copyFile, link, mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { fail, LOG_HINT } from '../errors'
import { removePath, removeStalePartFiles, writeFileAtomic } from '../fsx'
import { isValidId, newId as defaultNewId } from '../ids'
import type { Logger } from '../log'
import type { AppPaths } from '../paths'
import { nextTimestamp } from '../timing'
import { createEmptyProject, summarizeProject } from './defaults'
import { normalizeProject, UnsupportedProjectError } from './normalize'

export type ProjectEvent =
  { type: 'updated'; project: Project } | { type: 'deleted'; projectId: string }

export type ProjectListener = (event: ProjectEvent) => void

/** receives a mutable copy; may also return a replacement */
export type ProjectRecipe = (draft: Project) => Project | void

export interface UpdateOptions {
  /** false for progress-only changes: announced, but not written (they are reset on load anyway) */
  persist?: boolean
}

/** things the user has to know about the project files (shown as toasts) */
export type StoreNotice =
  /** a save failed – the first one of a streak; the store keeps retrying */
  | { type: 'save-failed' }
  /** every project is saved again after a save-failed */
  | { type: 'save-recovered' }
  /** project.json was damaged or missing and the backup was loaded instead */
  | { type: 'restored'; projectId: string; name: string }
  /** projects that neither project.json nor its backup could open (once per start) */
  | { type: 'unreadable'; count: number }

export interface ProjectStoreOptions {
  paths: Pick<
    AppPaths,
    'projectsDir' | 'projectDir' | 'projectFile' | 'projectTmpDir' | 'videoMediaDir'
  >
  log: Logger
  now?: () => Date
  newId?: () => string
  /** delay between the first unsaved change and the write (default 300 ms) */
  writeDelayMs?: number
  /** delay before retrying a failed write (default 5 s) */
  retryDelayMs?: number
  onNotice?: (notice: StoreNotice) => void
}

export const PROJECT_NOT_FOUND = 'The project was not found.'

export const STORE_MESSAGES = {
  saveFailed:
    'Your changes cannot be saved right now. Is the disk full? As soon as there is space ' +
    'again, the app goes on saving by itself.',
  saveRecovered: 'Everything is saved again.',
  restored: (name: string): string =>
    `“${name}” was damaged and was restored from the last backup. ` +
    'The latest changes may be missing.',
  unreadable: (count: number): string =>
    `${count === 1 ? '1 project' : `${count} projects`} could not be opened. ${LOG_HINT}`
} as const

/**
 * Notices about the user's data stay until they are closed: a failed save is announced once per
 * streak – while nothing is saved, it stays (until "Everything is saved again." replaces it).
 */
export function storeNoticeToast(notice: StoreNotice): ToastEvent {
  switch (notice.type) {
    case 'save-failed':
      return {
        level: 'warning',
        message: STORE_MESSAGES.saveFailed,
        sticky: true,
        key: TOAST_KEYS.projectSave
      }
    case 'save-recovered':
      return {
        level: 'success',
        message: STORE_MESSAGES.saveRecovered,
        key: TOAST_KEYS.projectSave
      }
    case 'restored':
      return { level: 'warning', message: STORE_MESSAGES.restored(notice.name), sticky: true }
    case 'unreadable':
      return { level: 'error', message: STORE_MESSAGES.unreadable(notice.count), sticky: true }
  }
}

/** Snapshots handed out by the store are frozen so nobody can change them behind its back. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

const errorCode = (err: unknown): unknown => (err as NodeJS.ErrnoException | null)?.code

/** link() errors of file systems that have no hard links (a full disk is not one of them) */
const NO_HARD_LINKS: ReadonlySet<string> = new Set([
  'EPERM',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EXDEV',
  'EMLINK'
])

type ReadResult =
  | { ok: true; project: Project; raw: unknown }
  | { ok: false; reason: 'missing' | 'unreadable' | 'unsupported' | 'damaged'; err?: unknown }

let backupCounter = 0

export class ProjectStore {
  private readonly projects = new Map<string, Project>()
  private readonly listeners = new Set<ProjectListener>()
  private readonly dirty = new Set<string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly writes = new Map<string, Promise<void>>()
  /** projects whose last write failed – a streak ends when this is empty again */
  private readonly failing = new Set<string>()
  private readonly paths: ProjectStoreOptions['paths']
  private readonly log: Logger
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly writeDelayMs: number
  private readonly retryDelayMs: number
  private readonly onNotice: (notice: StoreNotice) => void
  private closed = false

  constructor(options: ProjectStoreOptions) {
    this.paths = options.paths
    this.log = options.log
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? defaultNewId
    this.writeDelayMs = options.writeDelayMs ?? 300
    this.retryDelayMs = options.retryDelayMs ?? 5000
    this.onNotice = options.onNotice ?? (() => undefined)
  }

  /** loads every project folder; unreadable projects are logged and left untouched on disk */
  async init(): Promise<void> {
    await mkdir(this.paths.projectsDir, { recursive: true })
    const entries = await readdir(this.paths.projectsDir, { withFileTypes: true })
    let unreadable = 0
    for (const entry of entries) {
      if (entry.isDirectory() && isValidId(entry.name) && !(await this.load(entry.name))) {
        unreadable++
      }
    }
    this.log.info('projects', `loaded ${this.projects.size} project(s)`)
    if (unreadable > 0) this.notify({ type: 'unreadable', count: unreadable })
  }

  private backupFile(id: string): string {
    return `${this.paths.projectFile(id)}.bak`
  }

  private async read(id: string, file: string): Promise<ReadResult> {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (err) {
      // a file that cannot be read right now (disk error, no permission) may be a good one
      return errorCode(err) === 'ENOENT'
        ? { ok: false, reason: 'missing' }
        : { ok: false, reason: 'unreadable', err }
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (err) {
      return { ok: false, reason: 'damaged', err }
    }
    try {
      const project = normalizeProject(raw, {
        id,
        now: this.now().toISOString(),
        newId: this.newId
      })
      return { ok: true, project, raw }
    } catch (err) {
      const reason = err instanceof UnsupportedProjectError ? 'unsupported' : 'damaged'
      return { ok: false, reason, err }
    }
  }

  /** false when the folder holds a project that could not be opened (not even from its backup) */
  private async load(id: string): Promise<boolean> {
    const file = this.paths.projectFile(id)
    const primary = await this.read(id, file)
    if (primary.ok) {
      this.add(id, primary.project, JSON.stringify(primary.project) !== JSON.stringify(primary.raw))
      await this.removeLeftovers(id)
      return true
    }
    if (primary.reason === 'unsupported') {
      // written by a newer app version: never load (and thereby overwrite) it
      this.log.warn('projects', 'project skipped – newer file version', {
        projectId: id,
        err: primary.err
      })
      return false
    }
    if (primary.reason === 'unreadable') {
      // never replace it with the older backup: the next start may read it again
      this.log.error('projects', 'project skipped – project.json could not be read', {
        projectId: id,
        err: primary.err
      })
      return false
    }

    const backup = await this.read(id, this.backupFile(id))
    if (backup.ok) {
      this.log.warn('projects', 'project restored from backup', {
        projectId: id,
        reason: primary.reason,
        err: primary.err
      })
      // keep the damaged file aside, so the write-back below cannot turn it into the backup
      if (primary.reason === 'damaged') {
        await rename(file, `${file}.damaged`).catch((err: unknown) =>
          this.log.warn('projects', 'damaged project file not moved aside', { projectId: id, err })
        )
      }
      this.add(id, backup.project, true)
      await this.removeLeftovers(id)
      this.notify({ type: 'restored', projectId: id, name: backup.project.name })
      return true
    }
    if (primary.reason === 'missing' && backup.reason === 'missing') {
      this.log.warn('projects', 'folder without project.json skipped', { projectId: id })
      return true
    }
    // the folder (and its media) stays: user data is never deleted automatically
    this.log.error('projects', 'project could not be opened – skipped', {
      projectId: id,
      err: primary.err,
      backup: backup.reason,
      backupErr: backup.err
    })
    return false
  }

  private add(id: string, project: Project, repaired: boolean): void {
    this.projects.set(id, deepFreeze(project))
    if (repaired) this.markDirty(id)
  }

  /** temp files of interrupted writes and ffmpeg runs, scratch folders of interrupted exports */
  private async removeLeftovers(id: string): Promise<void> {
    const dir = this.paths.projectDir(id)
    try {
      for (const name of await readdir(dir)) {
        if (name.startsWith('project.json.') && name.endsWith('.tmp')) {
          await unlink(join(dir, name)).catch(() => undefined)
        }
      }
      await removePath(this.paths.projectTmpDir(id))
      // half proxies, posters and sprites of a run that was killed
      for (const video of this.projects.get(id)?.videos ?? []) {
        await removeStalePartFiles(this.paths.videoMediaDir(id, video.id))
      }
    } catch (err) {
      this.log.warn('projects', 'could not clean up leftovers', { projectId: id, err })
    }
  }

  subscribe(listener: ProjectListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: ProjectEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        this.log.error('projects', 'project listener failed', { err })
      }
    }
  }

  private notify(notice: StoreNotice): void {
    try {
      this.onNotice(notice)
    } catch (err) {
      this.log.error('projects', 'notice listener failed', { err })
    }
  }

  /** summaries, most recently changed first */
  list(): ProjectSummary[] {
    return [...this.projects.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(summarizeProject)
  }

  all(): Project[] {
    return [...this.projects.values()]
  }

  find(id: string): Project | undefined {
    return this.projects.get(id)
  }

  /** frozen snapshot; throws not-found */
  get(id: string): Project {
    return this.projects.get(id) ?? fail('not-found', PROJECT_NOT_FOUND)
  }

  async create(name: string): Promise<Project> {
    const id = this.newId()
    const empty = createEmptyProject(id, name, this.now().toISOString())
    // the export settings last used, without the folder (Settings has the default folder)
    const last = this.list()[0]
    const lastSettings = last && this.projects.get(last.id)?.exportSettings
    if (lastSettings) empty.exportSettings = { ...lastSettings, outputDir: null }
    const project = deepFreeze(empty)
    await writeFileAtomic(this.paths.projectFile(id), serializeProject(project))
    this.projects.set(id, project)
    this.emit({ type: 'updated', project })
    return project
  }

  /** applies `recipe` to a copy, stamps updatedAt, schedules a write and announces the result */
  update(id: string, recipe: ProjectRecipe, options: UpdateOptions = {}): Project {
    const current = this.get(id)
    const draft = structuredClone(current) as Project
    const result = recipe(draft) ?? draft
    const next = Object.isFrozen(result) ? (structuredClone(result) as Project) : result
    next.id = id
    next.updatedAt = nextTimestamp(current.updatedAt, this.now())
    deepFreeze(next)
    this.projects.set(id, next)
    if (options.persist !== false) this.markDirty(id)
    this.emit({ type: 'updated', project: next })
    return next
  }

  /** like update(), but silently does nothing when the project is gone */
  updateIfExists(id: string, recipe: ProjectRecipe, options?: UpdateOptions): Project | null {
    return this.projects.has(id) ? this.update(id, recipe, options) : null
  }

  /** removes the project and its folder (incl. media); pending writes are dropped */
  async delete(id: string): Promise<void> {
    this.get(id)
    this.projects.delete(id)
    this.dirty.delete(id)
    // its unsaved changes are moot now (no recovery notice: nothing was saved)
    this.failing.delete(id)
    this.clearTimer(id)
    await this.writes.get(id)
    await removePath(this.paths.projectDir(id))
    this.emit({ type: 'deleted', projectId: id })
  }

  /** an original video of any project (allow-list for hc-media and the shell) */
  hasVideoPath(path: string): boolean {
    const wanted = normalize(path)
    for (const project of this.projects.values()) {
      if (project.videos.some((video) => normalize(video.path) === wanted)) return true
    }
    return false
  }

  /** a file written by one of our exports */
  hasExportPath(path: string): boolean {
    const wanted = normalize(path)
    for (const project of this.projects.values()) {
      if (project.exports.some((record) => normalize(record.path) === wanted)) return true
    }
    return false
  }

  /** writes everything that is pending now */
  async flush(): Promise<void> {
    for (const id of [...this.timers.keys()]) this.clearTimer(id)
    await Promise.all([...this.dirty].map((id) => this.write(id)))
    await Promise.all([...this.writes.values()])
  }

  /** final flush on quit; later changes stay in memory only */
  async close(): Promise<void> {
    await this.flush()
    // a change made while the flush was writing is written too. Failed writes are not what keeps
    // this going, and three rounds are the limit: nothing may hold up the quit
    const changedMeanwhile = (): boolean => [...this.dirty].some((id) => !this.failing.has(id))
    for (let round = 0; round < 3 && changedMeanwhile(); round++) await this.flush()
    this.closed = true
    for (const id of [...this.timers.keys()]) this.clearTimer(id)
    if (this.dirty.size > 0) {
      this.log.error('projects', 'unsaved changes are lost on quit', {
        projectIds: [...this.dirty]
      })
    }
  }

  private markDirty(id: string): void {
    this.dirty.add(id)
    this.schedule(id, this.writeDelayMs)
  }

  private schedule(id: string, delayMs: number): void {
    if (this.closed || this.timers.has(id)) return
    const timer = setTimeout(() => {
      this.timers.delete(id)
      void this.write(id)
    }, delayMs)
    this.timers.set(id, timer)
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
  }

  /** queues a write behind the previous one of the same project (never rejects) */
  private write(id: string): Promise<void> {
    const previous = this.writes.get(id) ?? Promise.resolve()
    const next = previous.then(() => this.writeNow(id))
    this.writes.set(id, next)
    void next.then(() => {
      if (this.writes.get(id) === next) this.writes.delete(id)
    })
    return next
  }

  private async writeNow(id: string): Promise<void> {
    const project = this.projects.get(id)
    if (!this.dirty.delete(id) || !project) return
    const file = this.paths.projectFile(id)
    try {
      await this.backup(id, file)
      await writeFileAtomic(file, serializeProject(project))
    } catch (err) {
      this.log.error('projects', 'saving the project failed – will retry', { projectId: id, err })
      if (this.projects.has(id)) {
        if (this.failing.size === 0) this.notify({ type: 'save-failed' })
        this.failing.add(id)
        this.dirty.add(id)
        this.schedule(id, this.retryDelayMs)
      }
      return
    }
    if (this.failing.delete(id) && this.failing.size === 0) this.notify({ type: 'save-recovered' })
  }

  /**
   * The file that is about to be replaced becomes project.json.bak: a hard link (no copy, and
   * project.json itself is never missing), swapped in with a rename. Best effort – saving goes on
   * without it.
   */
  private async backup(id: string, file: string): Promise<void> {
    const tmp = `${file}.bak.${process.pid}.${++backupCounter}.tmp`
    try {
      try {
        await link(file, tmp)
      } catch (err) {
        if (errorCode(err) === 'ENOENT') return
        if (!NO_HARD_LINKS.has(String(errorCode(err)))) throw err
        // file systems without hard links: a copy (a clone on APFS) does the same job
        await copyFile(file, tmp, constants.COPYFILE_FICLONE)
      }
      await rename(tmp, this.backupFile(id))
      // after a save that failed past this step, project.json and the backup are one file: then
      // the rename does nothing (POSIX) and the temp link would stay – usually it is gone already
      await unlink(tmp).catch(() => undefined)
    } catch (err) {
      await unlink(tmp).catch(() => undefined)
      if (errorCode(err) !== 'ENOENT') {
        this.log.warn('projects', 'backup not updated', { projectId: id, err })
      }
    }
  }
}

function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2) + '\n'
}
