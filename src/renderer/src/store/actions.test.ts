import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeIpcError, TOAST_KEYS, type HighlightApi } from '@shared/ipc'
import { DEFAULT_BRIEF } from '@shared/presets'
import type { AppSettings, Moment, Project, ProjectSummary, ToastEvent } from '@shared/types'

const fake = vi.hoisted(() => ({
  removeVideo: vi.fn(),
  mutateProject: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  testApiKey: vi.fn(),
  retryPrepare: vi.fn(),
  startAnalysis: vi.fn(),
  analyzeAgain: vi.fn(),
  autoSelect: vi.fn(),
  openProject: vi.fn(),
  addVideos: vi.fn(),
  listProjects: vi.fn(async () => [])
}))
vi.mock('../api', () => ({ api: () => fake, initApi: vi.fn() }))

// toast() schedules with window.setTimeout
vi.stubGlobal('window', globalThis)

const actions = await import('./actions')
const { itemKey, useApp } = await import('./app-store')

const settings: AppSettings = {
  model: 'gemini-3.8-flash',
  hasApiKey: true,
  apiKeySource: 'keychain',
  defaultOutputDir: '/Users/demo/Movies/Glimpse',
  fakeAi: false
}

const project = {
  id: 'p1',
  updatedAt: '2026-11-01T12:00:00.000Z',
  videos: [],
  status: {},
  analyses: {},
  moments: [],
  reelEdited: false,
  brief: DEFAULT_BRIEF,
  exports: []
} as unknown as Project

const clip = {
  id: 'm1',
  videoId: 'v1',
  title: 'My favourite moment',
  selected: true,
  start: 2,
  end: 6
} as Moment
const withClip = { ...project, moments: [clip] }

/** a promise the test resolves by hand */
function later<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  for (const fn of Object.values(fake)) fn.mockReset()
  useApp.setState({
    project,
    settings,
    pending: {},
    toasts: [],
    settingsOpen: false,
    confirm: null,
    reviewFocus: {}
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('item changes (double clicks)', () => {
  it('removes a video once, however often it is clicked while main works', async () => {
    const reply = later<Project>()
    fake.removeVideo.mockReturnValue(reply.promise)
    const first = actions.removeVideo('v1')
    expect(useApp.getState().pending[itemKey.video('v1')]).toBe(true)
    const second = actions.removeVideo('v1')
    reply.resolve({ ...project, updatedAt: '2026-11-01T12:00:01.000Z' })
    await Promise.all([first, second])
    expect(fake.removeVideo).toHaveBeenCalledTimes(1)
    expect(useApp.getState().pending).toEqual({})
  })

  it('frees the item again when main refuses', async () => {
    fake.removeVideo.mockRejectedValue(
      new Error(encodeIpcError({ code: 'busy', message: 'Not right now.' }))
    )
    await actions.removeVideo('v1')
    expect(useApp.getState().pending).toEqual({})
    expect(useApp.getState().toasts.map((t) => t.message)).toEqual(['Not right now.'])
  })

  it('toggles a clip once while main works', async () => {
    useApp.setState({ project: withClip })
    const reply = later<Project>()
    fake.mutateProject.mockReturnValue(reply.promise)
    const runs = [actions.setMomentSelected('m1', false), actions.setMomentSelected('m1', false)]
    // another clip is not blocked
    const other = actions.setMomentSelected('m2', true)
    reply.resolve(project)
    await Promise.all([...runs, other])
    expect(fake.mutateProject.mock.calls).toEqual([
      ['p1', { type: 'toggleMoment', momentId: 'm1', selected: false }],
      ['p1', { type: 'toggleMoment', momentId: 'm2', selected: true }]
    ])
  })
})

describe('taking clips out', () => {
  const reply = (selected: boolean): Project => ({
    ...withClip,
    updatedAt: '2026-11-01T12:00:01.000Z',
    moments: [{ ...clip, selected }]
  })

  it('offers "Undo" after the row ✕, which takes the clip back in', async () => {
    useApp.setState({ project: withClip })
    fake.mutateProject.mockResolvedValue(reply(false))
    await actions.removeFromReel('m1')
    const [shown] = useApp.getState().toasts
    expect(shown).toMatchObject({
      message: '“My favourite moment” was removed from the highlight video.',
      action: { label: 'Undo' }
    })
    fake.mutateProject.mockResolvedValue(reply(true))
    shown.action?.run()
    await vi.waitFor(() => expect(useApp.getState().project?.moments[0].selected).toBe(true))
    expect(fake.mutateProject).toHaveBeenLastCalledWith('p1', {
      type: 'toggleMoment',
      momentId: 'm1',
      selected: true
    })
  })

  it('withdraws "Undo" once the clips are selected anew or analysed again', async () => {
    const offers = (): (string | undefined)[] =>
      useApp.getState().toasts.map((t) => t.action?.label)
    const takeOut = async (): Promise<void> => {
      useApp.setState({ project: withClip, settings })
      fake.mutateProject.mockResolvedValue(reply(false))
      await actions.removeFromReel('m1')
      expect(offers()).toEqual(['Undo'])
    }
    await takeOut()
    fake.autoSelect.mockResolvedValue(reply(false))
    expect(await actions.autoSelect()).not.toBeNull()
    expect(offers()).toEqual([])

    await takeOut()
    fake.analyzeAgain.mockResolvedValue(undefined)
    expect(await actions.analyzeAgain('More crowd.')).toBe(true)
    expect(offers()).toEqual([])

    await takeOut()
    fake.startAnalysis.mockResolvedValue(undefined)
    expect(await actions.startAnalysis({ videoIds: [] })).toBe(true)
    expect(offers()).toEqual([])
  })

  it('offers no "Undo" when main refuses', async () => {
    useApp.setState({ project: withClip })
    fake.mutateProject.mockRejectedValue(
      new Error(encodeIpcError({ code: 'busy', message: 'Not right now.' }))
    )
    await actions.removeFromReel('m1')
    expect(useApp.getState().toasts.map((t) => [t.message, t.action])).toEqual([
      ['Not right now.', undefined]
    ])
  })
})

describe('review focus', () => {
  it('keeps the clip and tab of every project while the app runs', async () => {
    actions.rememberReviewFocus('p1', { momentId: 'm1', tab: 'suggestions' })
    fake.openProject.mockResolvedValue({ ...project, id: 'p2' })
    await actions.openProject('p2')
    actions.goHome()
    fake.openProject.mockResolvedValue(project)
    await actions.openProject('p1')
    expect(useApp.getState().reviewFocus).toEqual({ p1: { momentId: 'm1', tab: 'suggestions' } })
  })
})

describe('API key', () => {
  it('stores a new key only after Google accepted it', async () => {
    fake.testApiKey.mockResolvedValue({
      ok: false,
      message: 'Google rejected this API key. Copy the whole key again in AI Studio.'
    })
    const rejected = await actions.connectApiKey(' AIza-half ')
    expect(rejected?.ok).toBe(false)
    expect(fake.testApiKey).toHaveBeenCalledWith('AIza-half')
    expect(fake.updateSettings).not.toHaveBeenCalled()

    fake.testApiKey.mockResolvedValue({
      ok: true,
      message: 'Connected: 4 models available'
    })
    fake.updateSettings.mockResolvedValue({ ...settings, hasApiKey: true })
    const accepted = await actions.connectApiKey('AIza-complete')
    expect(accepted).toMatchObject({ ok: true })
    expect(fake.updateSettings).toHaveBeenCalledWith({ apiKey: 'AIza-complete' })
  })

  it('reads the settings again when main says there is no usable key', async () => {
    const unreadable = { ...settings, hasApiKey: false, apiKeySource: null, apiKeyUnreadable: true }
    fake.getSettings.mockResolvedValue(unreadable)
    actions.handleError(
      new Error(
        encodeIpcError({
          code: 'no-api-key',
          message: 'Your saved API key can no longer be read. Paste it again in Settings.'
        })
      )
    )
    expect(useApp.getState().settingsOpen).toBe(true)
    await vi.waitFor(() => expect(useApp.getState().settings).toEqual(unreadable))
  })

  it('never lets an older read overwrite a newer change', async () => {
    const read = later<AppSettings>()
    fake.getSettings.mockReturnValue(read.promise)
    fake.updateSettings.mockResolvedValue({ ...settings, model: 'gemini-3.6-flash' })
    const refresh = actions.refreshSettings()
    await actions.updateSettings({ model: 'gemini-3.6-flash' })
    read.resolve(settings)
    await refresh
    expect(useApp.getState().settings?.model).toBe('gemini-3.6-flash')
  })
})

describe('preview rebuild from the analysis', () => {
  it('makes the preview again and lets the video join the analysis', async () => {
    fake.retryPrepare.mockResolvedValue(undefined)
    fake.startAnalysis.mockResolvedValue(undefined)
    // no reel and no trims: nothing to confirm
    await actions.rebuildPreview('v3')
    expect(fake.retryPrepare).toHaveBeenCalledWith('p1', 'v3')
    expect(fake.startAnalysis).toHaveBeenCalledWith('p1', { videoIds: ['v3'] })
  })
})

describe('"Ask Gemini again"', () => {
  const failedRun: ToastEvent = {
    level: 'warning',
    message: '2 videos could not be analysed: No connection.',
    projectId: 'p1',
    sticky: true,
    key: TOAST_KEYS.analysisFailed('p1')
  }

  it('hands the note to main in one call, then shows the analysis – without another question', async () => {
    useApp.setState({ view: { name: 'project', step: 'review' } })
    fake.analyzeAgain.mockResolvedValue(undefined)
    actions.showToast(failedRun)
    expect(await actions.analyzeAgain('More crowd.')).toBe(true)
    expect(fake.analyzeAgain).toHaveBeenCalledWith('p1', 'More crowd.')
    expect(fake.startAnalysis).not.toHaveBeenCalled()
    expect(fake.mutateProject).not.toHaveBeenCalled()
    expect(useApp.getState().confirm).toBeNull()
    expect(useApp.getState().view).toEqual({ name: 'project', step: 'analysis' })
    // the failures of the last run are history
    expect(useApp.getState().toasts).toEqual([])
  })

  it('stays in the Edit step and says why when main refuses', async () => {
    useApp.setState({ view: { name: 'project', step: 'review' } })
    fake.analyzeAgain.mockRejectedValue(
      new Error(encodeIpcError({ code: 'busy', message: 'The analysis is already running.' }))
    )
    expect(await actions.analyzeAgain('More crowd.')).toBe(false)
    expect(useApp.getState().view).toEqual({ name: 'project', step: 'review' })
    expect(useApp.getState().toasts.map((t) => t.message)).toEqual([
      'The analysis is already running.'
    ])
    expect(useApp.getState().busy.startAnalysis).toBe(false)
  })

  it('starts once, however often the button is clicked', async () => {
    const reply = later<void>()
    fake.analyzeAgain.mockReturnValue(reply.promise)
    const first = actions.analyzeAgain('More crowd.')
    const second = actions.analyzeAgain('More crowd.')
    expect(useApp.getState().busy.startAnalysis).toBe(true)
    reply.resolve()
    expect(await Promise.all([first, second])).toEqual([true, false])
    expect(fake.analyzeAgain).toHaveBeenCalledTimes(1)
  })
})

describe('toasts', () => {
  const failedRun = (projectId: string): ToastEvent => ({
    level: 'warning',
    message: '2 videos could not be analysed: No connection.',
    projectId,
    sticky: true,
    key: TOAST_KEYS.analysisFailed(projectId)
  })
  const messages = (): string[] => useApp.getState().toasts.map((t) => t.message)

  it('keeps what main marks sticky until it is closed, closes the others after reading time', () => {
    vi.useFakeTimers()
    actions.showToast(failedRun('p1'))
    actions.toast('success', 'Analysis done: 7 moments from 3 videos')
    vi.advanceTimersByTime(60_000)
    expect(messages()).toEqual([failedRun('p1').message])
  })

  it('replaces "not saved" with "saved again" (same key)', () => {
    vi.useFakeTimers()
    actions.showToast({ level: 'warning', message: 'Not saved.', sticky: true, key: 'k' })
    vi.advanceTimersByTime(60_000)
    expect(messages()).toEqual(['Not saved.'])
    actions.showToast({ level: 'success', message: 'Everything is saved again.', key: 'k' })
    expect(messages()).toEqual(['Everything is saved again.'])
    vi.advanceTimersByTime(60_000)
    expect(messages()).toEqual([])
  })

  it('does not follow the user to the start screen or into another project', async () => {
    fake.openProject.mockResolvedValue({ ...project, id: 'p2' })
    actions.showToast(failedRun('p1'))
    actions.showToast({ level: 'warning', message: 'Not saved.', sticky: true })
    await actions.openProject('p2')
    // an app-wide notice stays, the run of another project does not
    expect(messages()).toEqual(['Not saved.'])
    actions.showToast(failedRun('p2'))
    actions.goHome()
    expect(messages()).toEqual(['Not saved.'])
  })

  it('names the project when a run of another project ends', () => {
    const lisa = { id: 'lisa', name: 'Lisa’s birthday' } as ProjectSummary
    useApp.setState({ projects: [lisa] })
    actions.showToast({
      level: 'success',
      message: 'Analysis done: 5 moments from 2 videos',
      projectId: 'lisa'
    })
    actions.showToast(failedRun('lisa'))
    // the open project's own toasts stay as main wrote them
    actions.showToast({
      level: 'success',
      message: 'Done! Your highlight video is saved.',
      projectId: 'p1'
    })
    expect(messages()).toEqual([
      '“Lisa’s birthday”: Analysis done: 5 moments from 2 videos',
      `“Lisa’s birthday”: ${failedRun('lisa').message}`,
      'Done! Your highlight video is saved.'
    ])
  })

  it('names the project on the start screen too', () => {
    useApp.setState({
      project: null,
      projects: [{ id: 'lisa', name: 'Lisa’s birthday' } as ProjectSummary]
    })
    actions.showToast({
      level: 'success',
      message: 'Done! Your highlight video is saved.',
      projectId: 'lisa'
    })
    expect(messages()).toEqual(['“Lisa’s birthday”: Done! Your highlight video is saved.'])
  })

  it('names the project when its videos arrive after the user left it', async () => {
    const lisa = { ...project, name: 'Lisa’s birthday' } as Project
    useApp.setState({ project: lisa, imports: {} })
    const added = later<unknown>()
    fake.addVideos.mockReturnValue(added.promise)
    const adding = actions.addVideoPaths(['/v/a.mp4', '/v/b.mp4'])
    useApp.setState({ project: { ...project, id: 'p2' } })
    added.resolve({
      project: lisa,
      added: 2,
      skipped: [{ path: '/v/c.txt', reason: 'This is not a video.' }]
    })
    await adding
    expect(messages()).toEqual([
      '“Lisa’s birthday”: 2 videos added. Their previews are created in the background.',
      '“Lisa’s birthday”: “c.txt” was skipped: This is not a video.'
    ])
  })

  it('names the project of a toast main held while no window was open', async () => {
    const { initApi } = await import('../api')
    let deliver: (event: ToastEvent) => void = () => undefined
    const finished: ToastEvent = {
      level: 'success',
      message: 'Done! Your highlight video is saved.',
      projectId: 'lisa'
    }
    const client = {
      ...fake,
      onProjectUpdated: () => () => undefined,
      onExportProgress: () => () => undefined,
      onToast: (cb: (event: ToastEvent) => void) => {
        deliver = cb
        return () => undefined
      },
      getAppInfo: async () => null,
      // main sends the held toasts on the new window's first call, before it answers
      getSettings: async () => {
        deliver(finished)
        return settings
      },
      listProjects: async () => [{ id: 'lisa', name: 'Lisa’s birthday' } as ProjectSummary]
    } as unknown as HighlightApi
    vi.mocked(initApi).mockResolvedValue({ api: client, initial: null, mock: false })
    useApp.setState({ project: null, projects: [] })
    await actions.bootstrap()
    expect(messages()).toEqual(['“Lisa’s birthday”: Done! Your highlight video is saved.'])
  })

  it('drops the name again when the user opens that project', async () => {
    useApp.setState({
      project: null,
      projects: [{ id: 'lisa', name: 'Lisa’s birthday' } as ProjectSummary]
    })
    actions.showToast(failedRun('lisa'))
    fake.openProject.mockResolvedValue({ ...project, id: 'lisa', name: 'Lisa’s birthday' })
    await actions.openProject('lisa')
    expect(messages()).toEqual([failedRun('lisa').message])
  })

  it('closes the failures of the last run when the next run of that project starts', async () => {
    useApp.setState({ project, settings })
    fake.startAnalysis.mockResolvedValue(undefined)
    actions.showToast(failedRun('p1'))
    actions.showToast(failedRun('other'))
    expect(await actions.startAnalysis({ videoIds: [] })).toBe(true)
    expect(useApp.getState().toasts.map((t) => t.projectId)).toEqual(['other'])
  })
})
