// In-memory HighlightApi for running the renderer without Electron (browser dev, UI snapshots).
// Seeded scenarios are static; user actions (import, analysis, export) run short simulations.

import { estimateExportBytes } from '@shared/export-size'
import { encodeIpcError, TOAST_KEYS, type HighlightApi, type IpcErrorCode } from '@shared/ipc'
import {
  ANALYSIS_PARALLEL,
  DEFAULT_BRIEF,
  DEFAULT_EXPORT_SETTINGS,
  LIMITS,
  VIDEO_EXTENSIONS
} from '@shared/presets'
import { appendWish, wishProblem } from '@shared/second-pass'
import type {
  AnalysisRemedy,
  AppSettings,
  ExportProgress,
  Moment,
  Project,
  ToastEvent,
  VideoInfo
} from '@shared/types'
import { applyAutoSelect } from '../../../main/core/selection'
import { briefHash, isAnalysisFresh } from '../lib/brief-hash'
import { fileNameOf } from '../lib/format'
import { isMissingOriginal, summarize } from '../lib/project'
import type { InitialView } from './index'
import { buildWorld, MOCK_HOME, MOCK_MODELS, seedMoments, type MockWorld } from './mock-data'
import { MOCK_MESSAGES, mockAnalysisFailure, mockFailureToast } from './mock-messages'
import {
  installMockMedia,
  mockMediaPath,
  mockSpriteInfo,
  parseMockPath,
  registerMockVideo,
  type MockTheme
} from './mock-media'
import { applyMockMutation, insertChronologically } from './mock-mutations'
import type { MockScenario } from './scenarios'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const clone = <T>(value: T): T => structuredClone(value)
const nowIso = (): string => new Date().toISOString()

function ipcError(code: IpcErrorCode, message: string): Error {
  return new Error(encodeIpcError({ code, message }))
}

function hashString(value: string): number {
  let h = 0
  for (let i = 0; i < value.length; i++) h = (Math.imul(31, h) + value.charCodeAt(i)) | 0
  return Math.abs(h)
}

/**
 * The mock has no file system: a path without a file extension stands for a folder. It holds three
 * videos – unless its name says it is empty. null: not a folder.
 */
export function mockFolderContents(path: string): string[] | null {
  const name = fileNameOf(path)
  if (name.includes('.')) return null
  if (/empty/i.test(name)) return []
  const stamp = hashString(path) % 1_000_000
  return [1, 2, 3].map((i) => `${path}/VID_20261101_${String(stamp).padStart(6, '0')}${i}.mp4`)
}

const GENERIC_MOMENTS: [string, string][] = [
  ['Cheering in the crowd', 'The people around you go wild.'],
  ['Laughing with friends', 'You all burst out laughing at once.'],
  ['Musical climax', 'The song reaches its peak and the mood boils over.'],
  ['Beautiful view', 'A calm pan across the surroundings.'],
  ['Dancing in the lights', 'Colourful lights, everyone is dancing.'],
  ['A toast', 'Glasses meet, a short cheer.']
]

interface Run {
  cancelled: boolean
}

/** like main's run: explicit videos ("Try again") can join while it is running */
interface AnalysisRun extends Run {
  hash: string
  queue: string[]
  active: Set<string>
  /**
   * like main: the latest outcome per video, not per attempt – a video queued again starts over,
   * a removed one leaves. results: moments found per analysed video.
   */
  results: Map<string, number>
  failures: Map<string, { reason: string; remedy: AnalysisRemedy }>
  /** like main: a second pass whose reel was edited by hand – protected again if nothing is replaced */
  reelWasEdited?: boolean
  finished: boolean
}

/** how one video of a run ended; null: not analysed (cancelled, removed) */
type VideoOutcome =
  | { kind: 'done'; moments: number }
  | { kind: 'failed'; reason: string; remedy: AnalysisRemedy; fatal: boolean }
  | null

/**
 * main's end-of-run toast (an edited reel that would end up empty is put together automatically,
 * so it gets the normal text)
 */
function analysisDoneText(moments: number, videos: number, reel: 'rebuilt' | 'kept'): string {
  return reel === 'rebuilt'
    ? MOCK_MESSAGES.analysisDone(moments, videos)
    : MOCK_MESSAGES.analysisDoneReelKept(moments)
}

class MockBackend {
  private readonly projects = new Map<string, Project>()
  private settings: AppSettings
  private readonly world: MockWorld
  private readonly projectListeners = new Set<(project: Project) => void>()
  private readonly exportListeners = new Set<(event: ExportProgress) => void>()
  private readonly toastListeners = new Set<(event: ToastEvent) => void>()
  private readonly analysisRuns = new Map<string, AnalysisRun>()
  private readonly exportRuns = new Map<string, Run>()
  private readonly prepareQueue: { projectId: string; videoId: string }[] = []
  private preparing = 0
  private counter = 0

  constructor(world: MockWorld) {
    this.world = world
    this.settings = world.settings
    for (const project of world.projects) {
      this.projects.set(project.id, project)
      project.videos.forEach(registerMockVideo)
    }
  }

  private newId(prefix: string): string {
    this.counter++
    return `${prefix}-${Date.now().toString(36)}${this.counter.toString(36)}`
  }

  private get(id: string): Project {
    const project = this.projects.get(id)
    if (!project) throw ipcError('not-found', 'The project was not found.')
    return project
  }

  /** applies a recipe to a copy, stores it and broadcasts it like main's ProjectStore */
  private update(id: string, recipe: (project: Project) => void): Project | null {
    const current = this.projects.get(id)
    if (!current) return null
    const next = clone(current)
    recipe(next)
    next.updatedAt = nowIso()
    this.projects.set(id, next)
    this.emitProject(next)
    return next
  }

  private emitProject(project: Project): void {
    const copy = clone(project)
    setTimeout(() => this.projectListeners.forEach((listener) => listener(copy)), 0)
  }

  private emitExport(event: ExportProgress): void {
    setTimeout(() => this.exportListeners.forEach((listener) => listener({ ...event })), 0)
  }

  private toast(
    level: ToastEvent['level'],
    message: string,
    extra: Partial<ToastEvent> = {}
  ): void {
    const event: ToastEvent = { level, message, ...extra }
    setTimeout(() => this.toastListeners.forEach((listener) => listener({ ...event })), 0)
  }

  // -------------------------------------------------------------------------
  // Preparation (proxy + filmstrip)
  // -------------------------------------------------------------------------

  private queuePrepare(projectId: string, videoId: string): void {
    this.prepareQueue.push({ projectId, videoId })
    this.pumpPrepare()
  }

  private pumpPrepare(): void {
    while (this.preparing < 2 && this.prepareQueue.length > 0) {
      const job = this.prepareQueue.shift()
      if (!job) return
      this.preparing++
      void this.prepare(job.projectId, job.videoId).finally(() => {
        this.preparing--
        this.pumpPrepare()
      })
    }
  }

  private async prepare(projectId: string, videoId: string): Promise<void> {
    const exists = (): boolean =>
      !!this.projects.get(projectId)?.videos.some((v) => v.id === videoId)
    let progress = 0
    while (progress < 1) {
      await wait(260)
      if (!exists()) return
      progress = Math.min(1, progress + 0.07 + Math.random() * 0.05)
      this.update(projectId, (p) => {
        p.status[videoId].prepare = { status: 'running', progress }
      })
    }
    await wait(300)
    this.update(projectId, (p) => {
      const video = p.videos.find((v) => v.id === videoId)
      const media = video?.posterPath ? parseMockPath(video.posterPath) : null
      if (!video || !media) return
      video.proxyPath = mockMediaPath(media.theme, media.seed, 'proxy.mp4')
      video.spritePath = mockMediaPath(media.theme, media.seed, 'sprite.jpg')
      video.spriteInfo = mockSpriteInfo(video.durationSec, video.width, video.height)
      p.status[videoId].prepare = { status: 'done', progress: 1 }
    })
  }

  private createVideo(path: string, index: number): VideoInfo {
    const hash = hashString(path)
    const themes: MockTheme[] = ['stage', 'tent', 'night', 'fireworks', 'city']
    const theme = themes[hash % themes.length]
    const id = this.newId('v')
    const durationSec = 150 + (hash % 150) + 0.4
    const video: VideoInfo = {
      id,
      path,
      fileName: fileNameOf(path),
      sizeBytes: Math.round(durationSec * 1_310_000),
      durationSec,
      width: 1440,
      height: 1920,
      hasAudio: true,
      recordedAt: new Date(Date.now() - (10 - index) * 15 * 60_000).toISOString(),
      fingerprint: `${hash}`,
      proxyPath: null,
      posterPath: mockMediaPath(theme, id, 'poster.jpg'),
      spritePath: null,
      spriteInfo: null
    }
    registerMockVideo(video)
    return video
  }

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------

  private momentsFor(video: VideoInfo): Moment[] {
    const seeded = this.world.momentSeeds.get(video.id)
    if (seeded) return seedMoments(video.id, seeded)
    const hash = hashString(video.id)
    // like main (maxMomentItems): one moment per minute, at most 5
    const count = Math.min(3 + (hash % 3), Math.ceil(video.durationSec / 60))
    return Array.from({ length: count }, (_, i): Moment => {
      const length = 3 + ((hash >> i) % 5)
      const start = Math.round(((i + 0.3) / count) * (video.durationSec - length) * 10) / 10
      const [title, reason] = GENERIC_MOMENTS[(hash + i) % GENERIC_MOMENTS.length]
      return {
        id: `${video.id}-m${i + 1}`,
        videoId: video.id,
        start,
        end: start + length,
        title,
        reason,
        score: 5 + ((hash >> (i + 2)) % 6),
        selected: false,
        aiStart: start,
        aiEnd: start + length
      }
    })
  }

  /** like main: waits for the preview, then the stages; the fake triggers in the file name fail */
  private async analyseVideo(projectId: string, videoId: string, run: Run): Promise<VideoOutcome> {
    const setStage = (stage: Project['status'][string]['analysis']): void => {
      this.update(projectId, (p) => {
        if (p.status[videoId]) p.status[videoId].analysis = stage
      })
    }
    const startedAt = nowIso()
    const project = (): Project | undefined => this.projects.get(projectId)
    const fail = (reason: string, remedy: AnalysisRemedy, fatal = false): VideoOutcome => {
      setStage({
        stage: 'error',
        progress: 0,
        error: reason,
        remedy,
        startedAt,
        finishedAt: nowIso()
      })
      return { kind: 'failed', reason, remedy, fatal }
    }
    for (;;) {
      const current = project()
      const waiting = current?.videos.find((v) => v.id === videoId)
      if (run.cancelled || !current || !waiting) return null
      // like main: the proxy is what Gemini gets – a failed filmstrip does not stop the analysis
      if (waiting.proxyPath) break
      const prepare = current.status[videoId]?.prepare
      // like main: a failed preview fails the analysis right away, with the preview's reason
      if (prepare?.status === 'error') {
        return fail(
          MOCK_MESSAGES.previewMissing(prepare.error ?? MOCK_MESSAGES.proxyFailed),
          'prepare'
        )
      }
      setStage({
        stage: 'waiting-proxy',
        progress: -1,
        message: 'Waiting for the preview…',
        startedAt
      })
      await wait(500)
    }
    for (let progress = 0; progress <= 1; progress += 0.2) {
      if (run.cancelled) return null
      setStage({ stage: 'uploading', progress, message: 'Uploading…', startedAt })
      await wait(260)
    }
    if (run.cancelled) return null
    setStage({
      stage: 'processing',
      progress: -1,
      message: 'Gemini is processing the video…',
      startedAt
    })
    await wait(900)
    for (let progress = 0; progress <= 1; progress += 0.25) {
      if (run.cancelled) return null
      setStage({
        stage: 'analyzing',
        progress,
        message: 'Gemini is looking for the best moments…',
        startedAt
      })
      await wait(420)
    }
    const current = project()
    const video = current?.videos.find((v) => v.id === videoId)
    if (!current || !video || run.cancelled) return null
    const failure = mockAnalysisFailure(video.fileName)
    if (failure) return fail(failure.error, failure.remedy, failure.fatal)
    const moments = this.momentsFor(video)
    const hash = await briefHash(current.brief, this.settings.model)
    this.update(projectId, (p) => {
      // like main: unselected, next to their chronological neighbours; the order stays
      p.moments = insertChronologically(
        p,
        p.moments.filter((m) => m.videoId !== videoId),
        moments
      )
      p.analyses[videoId] = {
        videoId,
        model: this.settings.model,
        briefHash: hash,
        createdAt: nowIso()
      }
      p.status[videoId].analysis = {
        stage: 'done',
        progress: 1,
        message: MOCK_MESSAGES.momentsFound(moments.length),
        startedAt,
        finishedAt: nowIso()
      }
    })
    return { kind: 'done', moments: moments.length }
  }

  private markQueued(projectId: string, videoIds: string[]): void {
    this.update(projectId, (p) => {
      for (const videoId of videoIds) {
        if (p.status[videoId]) {
          p.status[videoId].analysis = { stage: 'queued', progress: 0, message: 'Queued' }
        }
      }
    })
  }

  /** like main: key, model or daily quota are unusable – the queued videos fail the same way */
  private failQueued(projectId: string, run: AnalysisRun, reason: string): void {
    const queued = run.queue.splice(0)
    const failing = queued.filter((videoId) => this.projects.get(projectId)?.status[videoId])
    this.update(projectId, (p) => {
      for (const videoId of failing) {
        p.status[videoId].analysis = {
          stage: 'error',
          progress: 0,
          error: reason,
          remedy: 'settings',
          finishedAt: nowIso()
        }
      }
    })
    for (const videoId of failing) run.failures.set(videoId, { reason, remedy: 'settings' })
  }

  /** main's no-api-key error: a stored key that cannot be read has its own text */
  private requireKey(message: string = MOCK_MESSAGES.noApiKey): void {
    if (this.settings.hasApiKey || this.settings.fakeAi) return
    throw ipcError(
      'no-api-key',
      this.settings.apiKeyUnreadable ? MOCK_MESSAGES.keyUnreadable : message
    )
  }

  private pumpAnalysis(projectId: string, run: AnalysisRun): void {
    while (!run.cancelled && run.active.size < ANALYSIS_PARALLEL && run.queue.length > 0) {
      const videoId = run.queue.shift()!
      run.active.add(videoId)
      void this.analyseVideo(projectId, videoId, run)
        .then((outcome) => {
          // a video removed meanwhile is not part of the run's summary
          if (!this.projects.get(projectId)?.status[videoId]) return
          if (outcome?.kind === 'done') {
            run.failures.delete(videoId)
            run.results.set(videoId, outcome.moments)
          } else if (outcome?.kind === 'failed') {
            run.results.delete(videoId)
            run.failures.set(videoId, { reason: outcome.reason, remedy: outcome.remedy })
            // like main: Settings shows the key Google rejected as rejected, not "Connected"
            if (outcome.reason === MOCK_MESSAGES.auth && this.settings.hasApiKey) {
              this.settings = { ...this.settings, apiKeyRejected: true }
            }
            if (outcome.fatal) this.failQueued(projectId, run, outcome.reason)
          }
        })
        .finally(() => {
          run.active.delete(videoId)
          this.pumpAnalysis(projectId, run)
        })
    }
    const drained = run.cancelled || run.queue.length === 0
    if (run.active.size > 0 || !drained || run.finished) return
    run.finished = true
    if (this.analysisRuns.get(projectId) === run) this.analysisRuns.delete(projectId)
    this.finishAnalysis(projectId, run)
  }

  /**
   * like main: an automatic reel is selected again, a reel edited by hand stays – unless none of
   * its clips is left, then it is put together automatically as well. Failures get one toast.
   */
  private finishAnalysis(projectId: string, run: AnalysisRun): void {
    const succeeded = run.results.size
    const moments = [...run.results.values()].reduce((sum, n) => sum + n, 0)
    if (succeeded === 0 && run.reelWasEdited) {
      this.update(projectId, (p) => {
        p.reelEdited = true
      })
    }
    if (succeeded > 0) {
      const current = this.projects.get(projectId)
      const keepReel = current?.reelEdited === true && current.moments.some((m) => m.selected)
      const project = keepReel ? current : this.update(projectId, applyAutoSelect)
      if (project && !run.cancelled) {
        this.toast('success', analysisDoneText(moments, succeeded, keepReel ? 'kept' : 'rebuilt'), {
          projectId
        })
      }
    }
    if (run.cancelled || run.failures.size === 0 || !this.projects.has(projectId)) return
    const { level, message } = mockFailureToast([...run.failures.values()], succeeded)
    // like main: stays until closed, leaves with this project's screens, replaced by the next run's
    this.toast(level, message, {
      projectId,
      sticky: true,
      key: TOAST_KEYS.analysisFailed(projectId)
    })
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  private async runExport(projectId: string, exportId: string, run: Run): Promise<void> {
    const project = this.get(projectId)
    const clips = project.moments.filter((m) => m.selected)
    const base = { projectId, exportId, clipCount: clips.length }
    const steps: Omit<ExportProgress, 'projectId' | 'exportId'>[] = [
      { phase: 'preparing', progress: 0.02, message: 'Preparing the export…' }
    ]
    clips.forEach((_, i) => {
      for (const part of [0, 0.5]) {
        steps.push({
          phase: 'rendering',
          progress: 0.05 + (0.8 * (i + part)) / clips.length,
          currentClip: i + 1,
          message: `Rendering clip ${i + 1} of ${clips.length}…`
        })
      }
    })
    steps.push({ phase: 'joining', progress: 0.88, message: 'Joining the clips…' })
    steps.push({ phase: 'finishing', progress: 0.97, message: 'Finishing up…' })
    for (const step of steps) {
      if (run.cancelled) {
        this.emitExport({
          ...base,
          phase: 'cancelled',
          progress: 0,
          message: 'Export cancelled.'
        })
        this.exportRuns.delete(projectId)
        return
      }
      this.emitExport({ ...base, ...step })
      await wait(320)
    }
    const stamp = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const dir = project.exportSettings.outputDir ?? this.settings.defaultOutputDir
    const outputPath =
      `${dir}/${project.name} – Highlights ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-` +
      `${pad(stamp.getDate())} ${pad(stamp.getHours())}.${pad(stamp.getMinutes())}.mp4`
    const durationSec = clips.reduce((sum, m) => sum + m.end - m.start, 0)
    this.update(projectId, (p) => {
      p.exports.push({
        id: exportId,
        path: outputPath,
        createdAt: nowIso(),
        durationSec,
        clipCount: clips.length,
        sizeBytes: estimateExportBytes(project.exportSettings.aspect, null, durationSec)
      })
    })
    this.exportRuns.delete(projectId)
    this.emitExport({
      ...base,
      phase: 'done',
      progress: 1,
      outputPath,
      message: MOCK_MESSAGES.exportDone
    })
    this.toast('success', MOCK_MESSAGES.exportSaved, { projectId })
  }

  // -------------------------------------------------------------------------
  // HighlightApi
  // -------------------------------------------------------------------------

  readonly api: HighlightApi = {
    getAppInfo: async () => {
      await wait(30)
      return clone(this.world.appInfo)
    },
    getSettings: async () => {
      await wait(30)
      return clone(this.settings)
    },
    updateSettings: async (patch) => {
      await wait(120)
      const next = { ...this.settings }
      if (patch.apiKey !== undefined) {
        // like main: storing or deleting the key replaces an unreadable or rejected one
        delete next.apiKeyUnreadable
        delete next.apiKeyRejected
        next.hasApiKey = !!patch.apiKey
        next.apiKeySource = patch.apiKey ? 'keychain' : null
      }
      if (patch.model) next.model = patch.model
      if (patch.defaultOutputDir) next.defaultOutputDir = patch.defaultOutputDir
      this.settings = next
      return clone(next)
    },
    testApiKey: async (apiKey) => {
      await wait(700)
      const key = apiKey?.trim()
      if (key === undefined && !this.settings.hasApiKey) {
        return {
          ok: false,
          message: this.settings.apiKeyUnreadable
            ? MOCK_MESSAGES.keyUnreadable
            : MOCK_MESSAGES.noKeyStored
        }
      }
      if (key !== undefined && !/^AIza[\w-]{20,}$/.test(key)) {
        return { ok: false, message: MOCK_MESSAGES.keyRejected, rejected: true }
      }
      // like main: Google accepts the stored key again
      if (key === undefined) {
        const accepted = { ...this.settings }
        delete accepted.apiKeyRejected
        this.settings = accepted
      }
      return {
        ok: true,
        message: MOCK_MESSAGES.keyOk(MOCK_MODELS.length),
        models: clone(MOCK_MODELS)
      }
    },
    listModels: async () => {
      await wait(200)
      this.requireKey(MOCK_MESSAGES.noKeyForModels)
      return clone(MOCK_MODELS)
    },

    listProjects: async () => {
      await wait(60)
      return [...this.projects.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((project) => summarize(project))
    },
    createProject: async (name) => {
      await wait(120)
      const id = this.newId('p')
      const created = nowIso()
      // like main: the export settings of the last changed project, without its folder
      const last = [...this.projects.values()].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt)
      )[0]
      const project: Project = {
        schemaVersion: 1,
        id,
        name: name?.trim() || 'New highlight video',
        createdAt: created,
        updatedAt: created,
        videos: [],
        status: {},
        brief: clone(DEFAULT_BRIEF),
        analyses: {},
        remoteFiles: {},
        moments: [],
        reelEdited: false,
        exportSettings: last
          ? { ...clone(last.exportSettings), outputDir: null }
          : clone(DEFAULT_EXPORT_SETTINGS),
        exports: []
      }
      this.projects.set(id, project)
      return clone(project)
    },
    openProject: async (id) => {
      await wait(60)
      return clone(this.get(id))
    },
    deleteProject: async (id) => {
      await wait(120)
      for (const runs of [this.analysisRuns, this.exportRuns]) {
        const run = runs.get(id)
        if (run) run.cancelled = true
      }
      this.projects.delete(id)
    },
    mutateProject: async (id, mutation) => {
      await wait(25)
      const next = applyMockMutation(this.get(id), mutation)
      next.updatedAt = nowIso()
      this.projects.set(id, next)
      this.emitProject(next)
      return clone(next)
    },

    pickVideoFiles: async () => {
      await wait(400)
      const stamp = Date.now().toString().slice(-6)
      return [1, 2, 3].map((i) => `${MOCK_HOME}/Movies/Meta/VID_20261101_${stamp}${i}.mp4`)
    },
    addVideos: async (id, paths) => {
      // main probes, fingerprints and renders a poster per file before it answers
      await wait(600 + 450 * paths.length)
      const project = this.get(id)
      const skipped: { path: string; reason: string }[] = []
      const added: VideoInfo[] = []
      // like main: a folder counts with the videos directly inside it (sorted by name)
      const files: string[] = []
      for (const path of paths) {
        const folder = mockFolderContents(path)
        if (folder === null) files.push(path)
        else if (folder.length === 0) skipped.push({ path, reason: MOCK_MESSAGES.emptyFolder })
        else files.push(...folder)
      }
      for (const path of files) {
        const extension = path.split('.').pop()?.toLowerCase() ?? ''
        if (!VIDEO_EXTENSIONS.includes(extension)) {
          skipped.push({ path, reason: MOCK_MESSAGES.notAVideo })
        } else if (
          project.videos.some((v) => v.path === path) ||
          added.some((v) => v.path === path)
        ) {
          skipped.push({ path, reason: MOCK_MESSAGES.alreadyInProject })
        } else {
          added.push(this.createVideo(path, project.videos.length + added.length))
        }
      }
      const next =
        this.update(id, (p) => {
          p.videos = [...p.videos, ...added].sort((a, b) =>
            (a.recordedAt ?? '').localeCompare(b.recordedAt ?? '')
          )
          for (const video of added) {
            p.status[video.id] = {
              prepare: { status: 'pending', progress: 0 },
              analysis: { stage: 'idle', progress: 0 }
            }
          }
        }) ?? project
      for (const video of added) this.queuePrepare(id, video.id)
      return { project: clone(next), added: added.length, skipped }
    },
    removeVideo: async (id, videoId) => {
      await wait(80)
      // like main: the video leaves a running analysis and its summary
      const run = this.analysisRuns.get(id)
      if (run) {
        run.queue = run.queue.filter((queued) => queued !== videoId)
        run.results.delete(videoId)
        run.failures.delete(videoId)
      }
      const next = this.update(id, (p) => {
        p.videos = p.videos.filter((v) => v.id !== videoId)
        p.moments = p.moments.filter((m) => m.videoId !== videoId)
        delete p.status[videoId]
        delete p.analyses[videoId]
        delete p.remoteFiles[videoId]
      })
      if (!next) throw ipcError('not-found', 'The project was not found.')
      return clone(next)
    },
    retryPrepare: async (id, videoId) => {
      await wait(60)
      this.update(id, (p) => {
        p.status[videoId].prepare = { status: 'pending', progress: 0 }
      })
      this.queuePrepare(id, videoId)
    },
    getPathForFile: (file) => {
      const withPath = file as File & { path?: string }
      return withPath.path || `${MOCK_HOME}/Desktop/${file.name}`
    },

    startAnalysis: async (id, options) => {
      await wait(150)
      this.requireKey()
      const project = this.get(id)
      if (project.videos.length === 0) throw ipcError('invalid', 'Add videos first.')
      const hash = await briefHash(project.brief, this.settings.model)
      // like main: explicit videos, else every video without a fresh result (all with force)
      if (options?.videoIds?.some((videoId) => !project.videos.some((v) => v.id === videoId))) {
        throw ipcError('not-found', 'The video was not found.')
      }
      const wanted = options?.videoIds ? new Set(options.videoIds) : null
      const targets = project.videos
        .filter((v) =>
          wanted ? wanted.has(v.id) : options?.force || !isAnalysisFresh(project, v.id, hash)
        )
        .map((v) => v.id)
      const running = this.analysisRuns.get(id)
      if (running) {
        const additions = targets.filter(
          (v) => !running.queue.includes(v) && !running.active.has(v)
        )
        if (options?.videoIds === undefined || running.hash !== hash || additions.length === 0) {
          throw ipcError('busy', 'The analysis is already running.')
        }
        // like main: a video queued again starts over
        for (const videoId of additions) {
          running.results.delete(videoId)
          running.failures.delete(videoId)
        }
        running.queue.push(...additions)
        this.markQueued(id, additions)
        this.pumpAnalysis(id, running)
        return
      }
      // nothing to analyse: a no-op, like main (the UI's freshness check may lag behind)
      if (targets.length === 0) return
      const run: AnalysisRun = {
        cancelled: false,
        hash,
        queue: [...targets],
        active: new Set(),
        results: new Map(),
        failures: new Map(),
        finished: false
      }
      this.analysisRuns.set(id, run)
      this.markQueued(id, targets)
      this.pumpAnalysis(id, run)
    },
    analyzeAgain: async (id, wish) => {
      await wait(150)
      // like main: the boundary check, then key, videos, no run going, the wish must fit
      const line = typeof wish === 'string' ? wish.trim() : ''
      if (!line || line.length > LIMITS.promptMax) {
        throw ipcError('invalid', 'Invalid request. (note)')
      }
      this.requireKey()
      const project = this.get(id)
      if (project.videos.length === 0) throw ipcError('invalid', 'Add videos first.')
      if (this.analysisRuns.has(id)) throw ipcError('busy', 'The analysis is already running.')
      if (wishProblem(project.brief.prompt, line)) {
        throw ipcError('invalid', MOCK_MESSAGES.wishTooLong)
      }
      // one step: the wish joins the brief, the reel is put together anew by the run
      this.update(id, (p) => {
        p.brief.prompt = appendWish(p.brief.prompt, line)
        p.reelEdited = false
      })
      await this.api.startAnalysis(id, { force: true })
      const run = this.analysisRuns.get(id)
      if (run) run.reelWasEdited = project.reelEdited
    },
    cancelAnalysis: async (id) => {
      await wait(80)
      const run = this.analysisRuns.get(id)
      if (run) run.cancelled = true
      this.analysisRuns.delete(id)
      this.update(id, (p) => {
        for (const status of Object.values(p.status)) {
          if (!['idle', 'done', 'error', 'cancelled'].includes(status.analysis.stage)) {
            status.analysis = { stage: 'cancelled', progress: 0, message: 'Cancelled' }
          }
        }
      })
    },
    autoSelect: async (id) => {
      await wait(120)
      const next = this.update(id, applyAutoSelect)
      if (!next) throw ipcError('not-found', 'The project was not found.')
      return clone(next)
    },

    chooseOutputDir: async () => {
      await wait(300)
      return `${MOCK_HOME}/Desktop/Highlights`
    },
    startExport: async (id) => {
      await wait(150)
      const project = this.get(id)
      if (!project.moments.some((m) => m.selected)) {
        throw ipcError('nothing-selected', 'Select at least one clip for your highlight video.')
      }
      if (!this.world.appInfo.ffmpeg.ok) {
        throw ipcError('no-ffmpeg', this.world.appInfo.ffmpeg.error ?? MOCK_MESSAGES.noFfmpeg)
      }
      if (this.exportRuns.has(id)) throw ipcError('busy', 'The export is already running.')
      const exportId = this.newId('e')
      const run: Run = { cancelled: false }
      this.exportRuns.set(id, run)
      void this.runExport(id, exportId, run)
      return { exportId }
    },
    cancelExport: async (id) => {
      await wait(60)
      const run = this.exportRuns.get(id)
      if (run) run.cancelled = true
    },

    showInFinder: async (path) => {
      await wait(30)
      this.toast('info', `Demo mode: “${fileNameOf(path)}” would now be shown in Finder.`)
    },
    openFile: async (path) => {
      await wait(30)
      this.toast('info', `Demo mode: “${fileNameOf(path)}” would now be played.`)
    },
    openOriginal: async (id, videoId) => {
      await wait(30)
      const project = this.get(id)
      const video = project.videos.find((v) => v.id === videoId)
      if (!video) throw ipcError('not-found', 'The video was not found.')
      // the mock's stand-in for main's file check: the original is gone when its preview says so
      if (isMissingOriginal(project.status[videoId]?.prepare.error)) {
        throw ipcError('not-found', MOCK_MESSAGES.missingOriginal(video.fileName))
      }
      this.toast('info', `Demo mode: “${video.fileName}” would now be played.`)
    },
    openExternal: async (url) => {
      await wait(30)
      this.toast('info', `Demo mode: ${url} would be opened in the browser.`)
    },

    onProjectUpdated: (cb) => {
      this.projectListeners.add(cb)
      return () => this.projectListeners.delete(cb)
    },
    onExportProgress: (cb) => {
      this.exportListeners.add(cb)
      return () => this.exportListeners.delete(cb)
    },
    onToast: (cb) => {
      this.toastListeners.add(cb)
      return () => this.toastListeners.delete(cb)
    }
  }
}

export async function createMockApi(
  scenario: MockScenario
): Promise<{ api: HighlightApi; initial: InitialView }> {
  installMockMedia()
  const world = await buildWorld(scenario)
  const backend = new MockBackend(world)
  return { api: backend.api, initial: world.initial }
}
