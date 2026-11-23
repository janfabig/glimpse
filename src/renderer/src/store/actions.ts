// Everything the UI can do. Actions call the API, feed results into the store and turn errors
// into toasts (or open the settings when the Gemini key is missing).

import { parseIpcError, TOAST_KEYS, type StartAnalysisOptions } from '@shared/ipc'
import type {
  ApiKeyTestResult,
  AppInfo,
  AppSettings,
  ExportProgress,
  MomentId,
  Project,
  ProjectId,
  ProjectMutation,
  SettingsPatch,
  ToastEvent,
  VideoId
} from '@shared/types'
import { api, initApi } from '../api'
import { analysisTargets, describeReanalysis, reanalysisImpact } from '../lib/analysis'
import { briefHash } from '../lib/brief-hash'
import { reelSignature } from '../lib/export'
import { fileNameOf, plural } from '../lib/format'
import { describeAutoSelect } from '../lib/moments'
import { upsertSummary } from '../lib/project'
import { initialStep, type StepId } from '../lib/steps'
import { addToast, toastDuration, toastsForScreen } from '../lib/toast'
import {
  itemKey,
  useApp,
  type BusyAction,
  type ConfirmRequest,
  type ReviewFocus,
  type ToastItem
} from './app-store'

const set = useApp.setState
const get = useApp.getState

// ---------------------------------------------------------------------------
// Toasts & errors
// ---------------------------------------------------------------------------

let toastSeq = 0

/**
 * Shows a toast. It closes by itself after a reading time – sticky ones (main: failed runs,
 * unsaved changes) stay until closed; a toast with the same key replaces an earlier one.
 */
export function showToast(event: ToastEvent, action?: ToastItem['action']): void {
  const id = ++toastSeq
  // about a project that is not open: say which one, or it reads as if it were about this screen
  const name =
    event.projectId !== currentProjectId() &&
    get().projects.find((p) => p.id === event.projectId)?.name
  const message = name ? `“${name}”: ${event.message}` : event.message
  const plainMessage = name ? event.message : undefined
  set((s) => ({ toasts: addToast(s.toasts, { ...event, message, id, action, plainMessage }) }))
  const duration = toastDuration(event.level, message, !!action, event.sticky)
  if (duration !== null) window.setTimeout(() => dismissToast(id), duration)
}

export function toast(level: ToastEvent['level'], message: string): void {
  showToast({ level, message })
}

export function dismissToast(id: number): void {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

/** closes the toast with this key (e.g. the failures of a project's last run) */
function dismissToastKey(key: string): void {
  set((s) => ({ toasts: s.toasts.filter((t) => t.key !== key) }))
}

/**
 * Another project or the start screen opens: toasts about other projects leave (a run's failure
 * would read as if it were about this one), and so do toast buttons such as "Undo".
 */
function leaveScreenToasts(nextProjectId: ProjectId | null): void {
  // what stays is about the screen that opens, so a project's name in front is no longer needed
  set((s) => ({
    toasts: toastsForScreen(s.toasts, nextProjectId).map((t) =>
      t.plainMessage === undefined ? t : { ...t, message: t.plainMessage }
    )
  }))
}

export function handleError(err: unknown): void {
  const error = parseIpcError(err)
  if (error.code === 'no-api-key') {
    toast('warning', error.message)
    // the key may have become unreadable since the settings were read (Keychain access denied)
    void refreshSettings()
    openSettings()
    return
  }
  toast('error', error.message)
}

async function attempt<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch (err) {
    handleError(err)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Busy actions & confirmation
// ---------------------------------------------------------------------------

const inFlight = new Set<BusyAction>()

function showBusy(action: BusyAction, value: boolean): void {
  set((s) => ({ busy: { ...s.busy, [action]: value } }))
}

/**
 * Runs an action at most once at a time – a double click must not create two projects or start
 * a second export. With `spinner`, its buttons show a spinner right away.
 */
async function exclusive<T>(
  action: BusyAction,
  run: () => Promise<T>,
  spinner = true
): Promise<T | undefined> {
  if (inFlight.has(action)) return undefined
  inFlight.add(action)
  if (spinner) showBusy(action, true)
  try {
    return await run()
  } finally {
    inFlight.delete(action)
    showBusy(action, false)
  }
}

/** shows the app-wide confirmation dialog; resolves true when the user confirms */
export function confirmDialog(request: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  get().confirm?.resolve(false)
  return new Promise((resolve) => set({ confirm: { ...request, resolve } }))
}

export function answerConfirm(ok: boolean): void {
  const request = get().confirm
  if (!request) return
  set({ confirm: null })
  request.resolve(ok)
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

let booted = false

export async function bootstrap(): Promise<void> {
  if (booted) return
  booted = true
  try {
    const setup = await initApi()
    const client = setup.api
    client.onProjectUpdated(receiveProject)
    client.onExportProgress(receiveExportProgress)
    // main sends toasts it held (no window was open) on the first call: name their project first
    const early: ToastEvent[] = []
    let named = false
    client.onToast((event) => (named ? showToast(event) : early.push(event)))
    // only the settings are essential; the rest degrades to a toast
    const orElse =
      <T>(value: T) =>
      (err: unknown): T => {
        handleError(err)
        return value
      }
    const [settings, appInfo, projects] = await Promise.all([
      client.getSettings(),
      client.getAppInfo().catch(orElse(null)),
      client.listProjects().catch(orElse([]))
    ])
    set({ settings, appInfo, projects })
    named = true
    for (const event of early.splice(0)) showToast(event)
    const initial = setup.initial
    if (initial?.projectId) {
      const project = await client.openProject(initial.projectId)
      if (initial.activeMomentId) {
        rememberReviewFocus(project.id, { momentId: initial.activeMomentId, tab: 'clips' })
      }
      set({ project, view: { name: 'project', step: initial.step ?? initialStep(project) } })
    }
    if (initial?.exportProgress) receiveExportProgress(initial.exportProgress)
    if (initial?.settingsOpen) set({ settingsOpen: true })
    set({ phase: 'ready' })
  } catch (err) {
    set({ phase: 'error', bootError: parseIpcError(err).message })
  }
}

function receiveProject(project: Project): void {
  const current = get().project
  if (current && current.id === project.id) {
    // events and invoke results can cross; never step back to an older state
    if (project.updatedAt < current.updatedAt) return
    set({ project })
  }
  set((s) => ({ projects: upsertSummary(s.projects, project) }))
}

function receiveExportProgress(event: ExportProgress): void {
  set((s) => {
    const exportProgress = { ...s.exportProgress, [event.projectId]: event }
    // an export this renderer did not start (e.g. after a reload): assume the current reel
    if (s.exportBasis[event.projectId] !== undefined || s.project?.id !== event.projectId) {
      return { exportProgress }
    }
    const exportBasis = { ...s.exportBasis, [event.projectId]: reelSignature(s.project) }
    return { exportProgress, exportBasis }
  })
}

// ---------------------------------------------------------------------------
// Navigation & projects
// ---------------------------------------------------------------------------

function currentProjectId(): string | null {
  return get().project?.id ?? null
}

export async function refreshProjects(): Promise<void> {
  const projects = await attempt(() => api().listProjects())
  if (projects) set({ projects })
}

export async function openProject(id: string, step?: StepId): Promise<void> {
  const project = await attempt(() => api().openProject(id))
  if (!project) return
  leaveScreenToasts(project.id)
  set({ project, view: { name: 'project', step: step ?? initialStep(project) } })
}

export function goHome(): void {
  leaveScreenToasts(null)
  set({ view: { name: 'home' }, project: null })
  void refreshProjects()
}

export function goToStep(step: StepId): void {
  if (get().project) set({ view: { name: 'project', step } })
}

export function rememberReviewFocus(projectId: ProjectId, focus: ReviewFocus): void {
  set((s) => ({ reviewFocus: { ...s.reviewFocus, [projectId]: focus } }))
}

export async function createProject(videoPaths: string[] = []): Promise<void> {
  const project = await exclusive('createProject', () => attempt(() => api().createProject()))
  if (!project) return
  leaveScreenToasts(project.id)
  set((s) => ({
    project,
    view: { name: 'project', step: 'videos' },
    projects: upsertSummary(s.projects, project)
  }))
  if (videoPaths.length > 0) await addVideoPaths(videoPaths)
}

export async function deleteProject(id: string, name: string): Promise<void> {
  const ok = await attempt(() =>
    api()
      .deleteProject(id)
      .then(() => true)
  )
  if (!ok) return
  set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }))
  toast('success', `“${name}” was deleted.`)
}

/** edits the open project – or `projectId`, for callbacks that may outlive their screen */
export async function mutate(
  mutation: ProjectMutation,
  projectId: ProjectId | null = currentProjectId()
): Promise<Project | null> {
  if (!projectId) return null
  const project = await attempt(() => api().mutateProject(projectId, mutation))
  if (!project) return null
  receiveProject(project)
  return project
}

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------

function trackImport(projectId: ProjectId, paths: string[], running: boolean): void {
  set((s) => {
    const current = s.imports[projectId] ?? []
    const next = running ? [...current, ...paths] : current.filter((p) => !paths.includes(p))
    return { imports: { ...s.imports, [projectId]: next } }
  })
}

/** main probes every file and makes its poster before it answers – that can take a few seconds */
export async function addVideoPaths(paths: string[]): Promise<void> {
  const id = currentProjectId()
  if (!id) return
  // dropping the same files again while they are being read in changes nothing
  const pending = get().imports[id] ?? []
  const fresh = [...new Set(paths)].filter((path) => !pending.includes(path))
  if (fresh.length === 0) return
  trackImport(id, fresh, true)
  const result = await attempt(() => api().addVideos(id, fresh))
  if (result) receiveProject(result.project)
  trackImport(id, fresh, false)
  if (!result) return
  // with the project: the user may have left it while main read the files in
  if (result.added > 0) {
    showToast({
      level: 'success',
      message: `${plural(result.added, 'video', 'videos')} added. ${result.added === 1 ? 'Its preview is' : 'Their previews are'} created in the background.`,
      projectId: id
    })
  }
  const [first, ...more] = result.skipped
  if (first) {
    const name = fileNameOf(first.path)
    showToast({
      level: 'warning',
      message:
        more.length === 0
          ? `“${name}” was skipped: ${first.reason}`
          : `${result.skipped.length} files were skipped, for example “${name}”: ${first.reason}`,
      projectId: id
    })
  }
}

export async function pickAndAddVideos(): Promise<void> {
  const paths = await exclusive('pickVideos', () => attempt(() => api().pickVideoFiles()))
  if (paths && paths.length > 0) await addVideoPaths(paths)
}

/**
 * Runs a change of one item (a video, a clip) at most once at a time: while main works on it, the
 * item renders disabled and further clicks on it do nothing (see AppState.pending).
 */
async function changeItem<T>(key: string, run: () => Promise<T>): Promise<T | undefined> {
  if (get().pending[key]) return undefined
  set((s) => ({ pending: { ...s.pending, [key]: true } }))
  try {
    return await attempt(run)
  } finally {
    set((s) => {
      const pending = { ...s.pending }
      delete pending[key]
      return { pending }
    })
  }
}

export async function removeVideo(videoId: VideoId): Promise<void> {
  const id = currentProjectId()
  if (!id) return
  const project = await changeItem(itemKey.video(videoId), () => api().removeVideo(id, videoId))
  if (project) receiveProject(project)
}

export async function retryPrepare(videoId: VideoId): Promise<void> {
  const id = currentProjectId()
  if (id) await attempt(() => api().retryPrepare(id, videoId))
}

/**
 * "Recreate preview" in the analysis: the preview is made again and the video joins the
 * analysis – it waits for the preview there.
 */
export async function rebuildPreview(videoId: VideoId): Promise<void> {
  const id = currentProjectId()
  if (!id) return
  const queued = await attempt(() =>
    api()
      .retryPrepare(id, videoId)
      .then(() => true)
  )
  if (queued) await startAnalysis({ videoIds: [videoId] })
}

/** takes a clip into the highlight video or out of it */
export async function setMomentSelected(momentId: MomentId, selected: boolean): Promise<void> {
  const id = currentProjectId()
  if (!id) return
  const project = await changeItem(itemKey.moment(momentId), () =>
    api().mutateProject(id, { type: 'toggleMoment', momentId, selected })
  )
  if (project) receiveProject(project)
}

/** the row ✕ in the reel: takes the clip out and offers to put it back in its old place */
export async function removeFromReel(momentId: MomentId): Promise<void> {
  await setMomentSelected(momentId, false)
  const moment = get().project?.moments.find((m) => m.id === momentId)
  // main refused, or a click while main was still busy with this clip
  if (!moment || moment.selected) return
  showToast(
    {
      level: 'info',
      message: `“${moment.title}” was removed from the highlight video.`,
      key: 'reel-undo'
    },
    // main's toggle keeps the clip's place in the order, so taking it back in restores it
    { label: 'Undo', run: () => void setMomentSelected(momentId, true) }
  )
}

// ---------------------------------------------------------------------------
// Analysis & selection
// ---------------------------------------------------------------------------

/**
 * Re-analysed videos get new moments in place of their AI moments. An automatic reel is rebuilt by
 * main after the run, a reel edited by hand (reelEdited) stays. Ask only when something made by
 * hand would be lost: clips of those videos in an edited reel, or the user's own trims.
 */
async function confirmReanalysis(
  project: Project,
  options?: StartAnalysisOptions
): Promise<boolean> {
  const model = get().settings?.model
  const hash = model ? await briefHash(project.brief, model) : null
  const impact = reanalysisImpact(project, analysisTargets(project, hash, options))
  if (!impact) return true
  return confirmDialog({
    title: 'Start the analysis?',
    message: describeReanalysis(impact),
    confirmLabel: 'Analyse'
  })
}

export async function startAnalysis(options?: StartAnalysisOptions): Promise<boolean> {
  const project = get().project
  if (!project) return false
  const started = await exclusive(
    'startAnalysis',
    async () => {
      if (!(await confirmReanalysis(project, options))) return false
      showBusy('startAnalysis', true)
      return attempt(() =>
        api()
          .startAnalysis(project.id, options)
          .then(() => true)
      )
    },
    false
  )
  if (!started) return false
  // the failures of the project's last run are history now
  dismissToastKey(TOAST_KEYS.analysisFailed(project.id))
  // "Undo" was about clips this run replaces
  dismissToastKey('reel-undo')
  if (currentProjectId() === project.id) goToStep('analysis')
  return true
}

/**
 * "Ask Gemini again": one call – main adds the note to the prompt and analyses every video
 * again. The dialog said what gets replaced, so nothing is asked here.
 */
export async function analyzeAgain(wish: string): Promise<boolean> {
  const project = get().project
  if (!project) return false
  const started = await exclusive('startAnalysis', () =>
    attempt(() =>
      api()
        .analyzeAgain(project.id, wish)
        .then(() => true)
    )
  )
  if (!started) return false
  dismissToastKey(TOAST_KEYS.analysisFailed(project.id))
  // "Undo" was about clips this run replaces
  dismissToastKey('reel-undo')
  if (currentProjectId() === project.id) goToStep('analysis')
  return true
}

export async function cancelAnalysis(): Promise<void> {
  const id = currentProjectId()
  if (id) await attempt(() => api().cancelAnalysis(id))
}

/**
 * "Auto-select": main replaces selection and order for the target length. A reel the
 * user edited by hand is only replaced after asking (an empty one has nothing to lose).
 */
export async function autoSelect(): Promise<Project | null> {
  const current = get().project
  if (!current) return null
  if (current.reelEdited && current.moments.some((m) => m.selected)) {
    const ok = await confirmDialog({
      title: 'Auto-select again?',
      message: describeAutoSelect(current),
      confirmLabel: 'Auto-select'
    })
    if (!ok) return null
  }
  const project = await attempt(() => api().autoSelect(current.id))
  if (!project) return null
  // "Undo" would change the new selection, not bring the old one back
  dismissToastKey('reel-undo')
  receiveProject(project)
  return project
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function startExport(): Promise<void> {
  const project = get().project
  if (!project) return
  const id = project.id
  const basis = reelSignature(project)
  const started = await exclusive('startExport', () => attempt(() => api().startExport(id)))
  if (!started) return
  dismissToastKey(TOAST_KEYS.exportFailed(id))
  set((s) => ({ exportBasis: { ...s.exportBasis, [id]: basis } }))
  const current = get().exportProgress[id]
  if (!current || current.exportId !== started.exportId) {
    receiveExportProgress({
      projectId: id,
      exportId: started.exportId,
      phase: 'preparing',
      progress: 0,
      message: 'Preparing the export…'
    })
  }
}

export async function cancelExport(): Promise<void> {
  const id = currentProjectId()
  if (id) await attempt(() => api().cancelExport(id))
}

export function clearExportProgress(projectId: string): void {
  set((s) => {
    const exportProgress = { ...s.exportProgress }
    const exportBasis = { ...s.exportBasis }
    delete exportProgress[projectId]
    delete exportBasis[projectId]
    return { exportProgress, exportBasis }
  })
}

export async function chooseExportDir(): Promise<void> {
  const dir = await attempt(() => api().chooseOutputDir())
  if (dir) await mutate({ type: 'setExportSettings', patch: { outputDir: dir } })
}

// ---------------------------------------------------------------------------
// Settings & app
// ---------------------------------------------------------------------------

export function openSettings(): void {
  set({ settingsOpen: true })
}

export function closeSettings(): void {
  set({ settingsOpen: false })
}

/** bumped by every settings change, so an older read cannot overwrite a newer change */
let settingsWrites = 0

/** reads the settings again – main's view can change without an event (e.g. an unreadable key) */
export async function refreshSettings(): Promise<void> {
  const writes = settingsWrites
  try {
    const settings = await api().getSettings()
    if (writes === settingsWrites) set({ settings })
  } catch {
    // keep what we have; the next action that needs the settings reports the problem
  }
}

export async function updateSettings(patch: SettingsPatch): Promise<AppSettings | null> {
  settingsWrites++
  const previous = get().settings
  // plain values show up immediately so controlled inputs don't jump back; the key is main's business
  if (previous) {
    const optimistic = { ...previous }
    if (patch.model !== undefined) optimistic.model = patch.model
    if (patch.defaultOutputDir !== undefined) optimistic.defaultOutputDir = patch.defaultOutputDir
    set({ settings: optimistic })
  }
  const settings = await attempt(() => api().updateSettings(patch))
  if (!settings) {
    if (previous) set({ settings: previous })
    return null
  }
  set({ settings })
  return settings
}

/**
 * Tests a new API key and stores it only when Google accepts it; null when storing failed (the
 * error is shown as a toast).
 */
export async function connectApiKey(key: string): Promise<ApiKeyTestResult | null> {
  const value = key.trim()
  let result: ApiKeyTestResult
  try {
    result = await api().testApiKey(value)
  } catch (err) {
    return { ok: false, message: parseIpcError(err).message }
  }
  if (!result.ok) return result
  return (await updateSettings({ apiKey: value })) ? result : null
}

/** asks main again (it looks for ffmpeg anew while none works); null when that failed */
export async function refreshAppInfo(): Promise<AppInfo | null> {
  const appInfo = await attempt(() => api().getAppInfo())
  if (appInfo) set({ appInfo })
  return appInfo ?? null
}

export const shell = {
  showInFinder: (path: string): Promise<unknown> => attempt(() => api().showInFinder(path)),
  openFile: (path: string): Promise<unknown> => attempt(() => api().openFile(path)),
  openOriginal: (id: ProjectId, videoId: VideoId): Promise<unknown> =>
    attempt(() => api().openOriginal(id, videoId)),
  openExternal: (url: string): Promise<unknown> => attempt(() => api().openExternal(url))
}
