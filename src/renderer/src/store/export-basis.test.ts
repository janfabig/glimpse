// Which reel a finished export describes: the store remembers the reel signature of the click
// ("exportBasis"), whatever order main's answer, its progress events and project updates arrive in.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeIpcError, type HighlightApi } from '@shared/ipc'
import type { AppSettings, ExportProgress, Moment, Project } from '@shared/types'
import { exportOutdated, reelSignature } from '../lib/export'

const fake = vi.hoisted(() => ({ startExport: vi.fn() }))
vi.mock('../api', () => ({ api: () => fake, initApi: vi.fn() }))

// toast() schedules with window.setTimeout
vi.stubGlobal('window', globalThis)

const actions = await import('./actions')
const { useApp } = await import('./app-store')

const clip = { id: 'm1', videoId: 'v1', selected: true, start: 2, end: 6 } as Moment
const project = {
  id: 'p1',
  name: 'Festival',
  updatedAt: '2026-11-01T12:00:00.000Z',
  videos: [],
  status: {},
  analyses: {},
  moments: [clip],
  exports: []
} as unknown as Project
/** the user trimmed the clip after the click on "Create highlight video" */
const trimmed = {
  ...project,
  updatedAt: '2026-11-01T12:00:05.000Z',
  moments: [{ ...clip, end: 5 }]
} as Project

let sendProject: (project: Project) => void = () => undefined
let sendProgress: (event: ExportProgress) => void = () => undefined
const progress = (phase: ExportProgress['phase'], exportId = 'e1'): ExportProgress => ({
  projectId: 'p1',
  exportId,
  phase,
  progress: phase === 'done' ? 1 : 0.4
})
const state = (): { progress?: ExportProgress; basis?: string } => ({
  progress: useApp.getState().exportProgress.p1,
  basis: useApp.getState().exportBasis.p1
})
/** what ExportStep asks: is the stored result about another reel than the one on screen? */
const outdated = (): boolean => {
  const current = useApp.getState().project
  return !!current && exportOutdated(state().progress, state().basis, current)
}

beforeAll(async () => {
  const { initApi } = await import('../api')
  const client = {
    ...fake,
    onProjectUpdated: (cb: (project: Project) => void) => {
      sendProject = cb
      return () => undefined
    },
    onExportProgress: (cb: (event: ExportProgress) => void) => {
      sendProgress = cb
      return () => undefined
    },
    onToast: () => () => undefined,
    getSettings: async () => ({ model: 'gemini-3.8-flash' }) as AppSettings,
    getAppInfo: async () => null,
    listProjects: async () => []
  } as unknown as HighlightApi
  vi.mocked(initApi).mockResolvedValue({ api: client, initial: null, mock: false })
  await actions.bootstrap()
})

beforeEach(() => {
  fake.startExport.mockReset()
  useApp.setState({ project, exportProgress: {}, exportBasis: {}, toasts: [], busy: {} })
})

describe('the reel an export describes', () => {
  it('is the reel of the click, and the progress shows before main reports any', async () => {
    fake.startExport.mockResolvedValue({ exportId: 'e1' })
    await actions.startExport()
    expect(fake.startExport).toHaveBeenCalledWith('p1')
    expect(state().basis).toBe(reelSignature(project))
    expect(state().progress).toMatchObject({ exportId: 'e1', phase: 'preparing', progress: 0 })
    expect(outdated()).toBe(false)
  })

  it('stays the reel of the click when a trim and the first event overtake main’s answer', async () => {
    let answer: (value: { exportId: string }) => void = () => undefined
    fake.startExport.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const run = actions.startExport()
    sendProject(trimmed)
    sendProgress(progress('rendering'))
    answer({ exportId: 'e1' })
    await run
    expect(state().basis).toBe(reelSignature(project))
    // the event is newer than the placeholder of the start
    expect(state().progress?.phase).toBe('rendering')
    // a running export is never thrown away …
    expect(outdated()).toBe(false)
    // … its result is, once it ends: it shows the reel before the trim
    sendProgress(progress('done'))
    expect(outdated()).toBe(true)
  })

  it('keeps the result while the reel is the one that was exported', async () => {
    fake.startExport.mockResolvedValue({ exportId: 'e1' })
    await actions.startExport()
    sendProgress(progress('done'))
    expect(outdated()).toBe(false)
    sendProject(trimmed)
    expect(outdated()).toBe(true)
    actions.clearExportProgress('p1')
    expect(state()).toEqual({ progress: undefined, basis: undefined })
  })

  it('replaces the result of the export before with the new one', async () => {
    fake.startExport.mockResolvedValue({ exportId: 'e1' })
    await actions.startExport()
    sendProgress(progress('done'))
    sendProject(trimmed)
    // "Export again" without a visit of the export step in between
    fake.startExport.mockResolvedValue({ exportId: 'e2' })
    await actions.startExport()
    expect(state().basis).toBe(reelSignature(trimmed))
    expect(state().progress).toMatchObject({ exportId: 'e2', phase: 'preparing' })
    sendProgress(progress('done', 'e2'))
    expect(outdated()).toBe(false)
  })

  it('takes the reel on screen for an export this window did not start (reload)', () => {
    sendProgress(progress('rendering'))
    expect(state().basis).toBe(reelSignature(project))
    // an event of a project that is not open says nothing about a reel
    useApp.setState({ exportBasis: {}, project: { ...project, id: 'other' } })
    sendProgress(progress('rendering'))
    expect(state().basis).toBeUndefined()
    expect(state().progress?.phase).toBe('rendering')
  })

  it('remembers nothing when main refuses to start', async () => {
    fake.startExport.mockRejectedValue(
      new Error(encodeIpcError({ code: 'busy', message: 'The export is already running.' }))
    )
    await actions.startExport()
    expect(state()).toEqual({ progress: undefined, basis: undefined })
    expect(useApp.getState().toasts.map((t) => t.message)).toEqual([
      'The export is already running.'
    ])
  })
})
