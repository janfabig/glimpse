import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseIpcError, TOAST_KEYS } from '@shared/ipc'
import type { HighlightApi } from '@shared/ipc'
import { DEFAULT_BRIEF, DEFAULT_EXPORT_SETTINGS, LIMITS } from '@shared/presets'
import type { AnalysisRemedy, Moment, Project, ProjectMutation, ToastEvent } from '@shared/types'
import { createFakeAnalyzer } from '../../../main/ai/fake'
import { MESSAGES as AI_MESSAGES } from '../../../main/ai/messages'
import { dailyQuotaAlternative, MODEL_CATALOG } from '../../../main/ai/models'
import { maxMomentItems } from '../../../main/ai/prompt'
import { AnalyzerError } from '../../../main/contracts'
import { IPC_MESSAGES } from '../../../main/core/ipc/handlers'
import {
  analysisRemedy,
  failureToast,
  isFatalForRun,
  type Failure
} from '../../../main/core/jobs/analysis'
import { JOB_MESSAGES } from '../../../main/core/jobs/messages'
import { applyMutation, MUTATION_MESSAGES } from '../../../main/core/mutations'
import { autoSelect } from '../../../main/core/selection'
import { MESSAGES as MEDIA_MESSAGES } from '../../../main/media/errors'
import { mockAllowed } from './index'
import { createMockApi } from './mock'
import { buildWorld, MOCK_MODELS } from './mock-data'
import { MOCK_MESSAGES, mockAnalysisFailure, mockFailureToast } from './mock-messages'
import { applyMockMutation } from './mock-mutations'
import { MOCK_SCENARIOS, parseScenario } from './scenarios'

// the mock hashes the brief with WebCrypto, which answers on the real event loop – fake timers
// alone would run ahead of it
const realSetImmediate = setImmediate

/** advances the fake clock until `done` holds, letting real async work finish in between */
async function advanceUntil(done: () => boolean, maxMs = 120_000): Promise<void> {
  for (let elapsed = 0; !done(); elapsed += 250) {
    if (elapsed > maxMs) throw new Error('the mock did not get there in time')
    await vi.advanceTimersByTimeAsync(250)
    await new Promise((resolve) => realSetImmediate(resolve))
  }
}

async function reviewProject(): Promise<Project> {
  const world = await buildWorld('review', Date.parse('2026-11-01T12:00:00.000Z'))
  return world.projects[0]
}

describe('mock world', () => {
  it('builds every scenario with consistent data', async () => {
    for (const scenario of MOCK_SCENARIOS) {
      const world = await buildWorld(scenario)
      for (const project of world.projects) {
        const videoIds = new Set(project.videos.map((v) => v.id))
        expect(project.moments.every((m) => videoIds.has(m.videoId))).toBe(true)
        expect(project.videos.every((v) => project.status[v.id])).toBe(true)
      }
      if (world.initial.projectId) {
        expect(world.projects.some((p) => p.id === world.initial.projectId)).toBe(true)
      }
    }
    expect((await buildWorld('nokey')).projects).toHaveLength(0)
    expect((await buildWorld('nokey')).settings.hasApiKey).toBe(false)
    expect((await buildWorld('noffmpeg')).appInfo.ffmpeg.ok).toBe(false)
  })

  it('falls back to the home scenario', () => {
    expect(parseScenario('review')).toBe('review')
    expect(parseScenario('nope')).toBe('home')
    expect(parseScenario(null)).toBe('home')
  })

  it('is only used when asked for or in the dev server – never as a silent fallback', () => {
    expect(mockAllowed('?mock=1&scenario=review', false)).toBe(true)
    expect(mockAllowed('', true)).toBe(true)
    expect(mockAllowed('', false)).toBe(false)
    expect(mockAllowed('?mock=0', false)).toBe(false)
  })
})

describe('mock mutations match main', () => {
  it('produces the same project as main for every mutation type', async () => {
    const project = await reviewProject()
    const [first, second] = project.moments.filter((m) => m.selected)
    const unselected = project.moments.find((m) => !m.selected)!
    const mutations: ProjectMutation[] = [
      { type: 'rename', name: '  Summer 2026  ' },
      { type: 'setBrief', patch: { prompt: 'Only the stage', targetDurationSec: 90 } },
      { type: 'setBrief', patch: { targetDurationSec: null } },
      { type: 'setExportSettings', patch: { aspect: '1:1', transition: 'crossfade' } },
      { type: 'toggleMoment', momentId: first.id, selected: false },
      { type: 'toggleMoment', momentId: unselected.id, selected: true },
      { type: 'updateMomentTimes', momentId: first.id, start: first.start - 0.333, end: first.end },
      // the same times: no edit
      { type: 'updateMomentTimes', momentId: first.id, start: first.start, end: first.end },
      { type: 'resetMomentTimes', momentId: first.id },
      { type: 'reorderMoment', momentId: second.id, toIndex: 0 },
      { type: 'reorderMoment', momentId: first.id, toIndex: 3 },
      { type: 'reorderMoment', momentId: first.id, toIndex: 99 },
      { type: 'reorderMoment', momentId: unselected.id, toIndex: 1 }
    ]
    // a reordered reel
    const shuffled = applyMutation(project, {
      type: 'reorderMoment',
      momentId: second.id,
      toIndex: 0
    })
    // the review world's reel was edited by hand – also start from an automatic one, and from one
    // whose clip was trimmed by the automatic selection
    const automatic: Project = { ...project, reelEdited: false }
    const autoTrimmed: Project = {
      ...automatic,
      moments: automatic.moments.map((m) =>
        m.id === first.id ? { ...m, autoTrimmedFrom: { start: m.start - 1, end: m.end } } : m
      )
    }
    for (const base of [project, shuffled, automatic, autoTrimmed]) {
      for (const mutation of mutations) {
        expect(applyMockMutation(base, mutation), mutation.type).toEqual(
          applyMutation(base, mutation)
        )
      }
    }
    const toggled = applyMockMutation(automatic, {
      type: 'toggleMoment',
      momentId: unselected.id,
      selected: true
    })
    expect(toggled.reelEdited).toBe(true)
    const renamed = applyMockMutation(automatic, { type: 'rename', name: 'New' })
    expect(renamed.reelEdited).toBe(false)
  })
})

describe('mock keeps footage out of the highlight video twice, like main', () => {
  it('stops trims at a neighbour and refuses to take in or reset onto shared footage', async () => {
    const world = await reviewProject()
    const [template] = world.moments
    const clip = (id: string, start: number, end: number, selected: boolean): Moment => ({
      ...template,
      id,
      start,
      end,
      aiStart: start,
      aiEnd: end,
      selected
    })
    // one video: a and b are in the highlight video, x lies between them and is not
    const project: Project = {
      ...world,
      moments: [clip('a', 5, 9, true), clip('x', 12, 15, false), clip('b', 20, 24, true)]
    }
    const outcome = (
      run: typeof applyMutation,
      base: Project,
      mutation: ProjectMutation
    ): unknown => {
      try {
        return run(base, mutation)
      } catch (err) {
        return parseIpcError(err)
      }
    }
    const trim = (momentId: string, start: number, end: number): ProjectMutation => ({
      type: 'updateMomentTimes',
      momentId,
      start,
      end
    })
    const grown = applyMutation(project, trim('a', 5, 13))
    const squeezed = applyMutation(applyMutation(project, trim('a', 5, 7)), trim('b', 8, 24))
    const cases: [Project, ProjectMutation][] = [
      [project, trim('a', 3, 22)],
      [project, trim('b', 7, 30)],
      [project, trim('x', 6, 22)],
      [grown, { type: 'toggleMoment', momentId: 'x', selected: true }],
      [project, { type: 'toggleMoment', momentId: 'x', selected: true }],
      [squeezed, { type: 'resetMomentTimes', momentId: 'a' }],
      [squeezed, { type: 'resetMomentTimes', momentId: 'b' }]
    ]
    for (const [base, mutation] of cases) {
      expect(outcome(applyMockMutation, base, mutation), JSON.stringify(mutation)).toEqual(
        outcome(applyMutation, base, mutation)
      )
    }
    expect(outcome(applyMockMutation, grown, cases[3][1])).toEqual({
      code: 'invalid',
      message: MUTATION_MESSAGES.footageTwice
    })
    expect(applyMockMutation(project, trim('a', 3, 22)).moments[0]).toMatchObject({
      start: 3,
      end: 20
    })
  })
})

describe('mock mutations', () => {
  it('validates names', async () => {
    const project = await reviewProject()
    expect(applyMockMutation(project, { type: 'rename', name: '  New  ' }).name).toBe('New')
    try {
      applyMockMutation(project, { type: 'rename', name: ' ' })
      expect.unreachable()
    } catch (err) {
      expect(parseIpcError(err).code).toBe('invalid')
    }
  })

  it('clamps trims to the video and keeps the AI times for a reset', async () => {
    const project = await reviewProject()
    const target = project.moments[0]
    const video = project.videos.find((v) => v.id === target.videoId)!
    const trimmed = applyMockMutation(project, {
      type: 'updateMomentTimes',
      momentId: target.id,
      start: -3,
      end: video.durationSec + 10
    })
    const after = trimmed.moments.find((m) => m.id === target.id)!
    expect(after.start).toBe(0)
    // main's grid: the last 0.01 s step that lies inside the video
    expect(after.end).toBe(Math.floor(video.durationSec * 100) / 100)
    const reset = applyMockMutation(trimmed, { type: 'resetMomentTimes', momentId: target.id })
    expect(reset.moments.find((m) => m.id === target.id)).toMatchObject({
      start: target.aiStart,
      end: target.aiEnd
    })
    expect(() =>
      applyMockMutation(project, {
        type: 'updateMomentTimes',
        momentId: target.id,
        start: 5,
        end: 5.2
      })
    ).toThrow()
  })
})

describe('mock auto selection', () => {
  it('fills the target length within the tolerance', async () => {
    const project = await reviewProject()
    const selected = autoSelect(project).filter((m) => m.selected)
    const total = selected.reduce((sum, m) => sum + m.end - m.start, 0)
    expect(total).toBeLessThanOrEqual(60 + Math.max(2, 0.08 * 60))
    expect(total).toBeGreaterThan(0.85 * 60)
  })

  it('marks a top-up trim and starts from the untrimmed clip next time', async () => {
    const base = await reviewProject()
    const videoId = base.videos[0].id
    const clip = (id: string, start: number, score: number): Moment => ({
      id,
      videoId,
      start,
      end: start + 10,
      title: id,
      reason: '',
      score,
      selected: false,
      aiStart: start,
      aiEnd: start + 10
    })
    const project: Project = {
      ...base,
      moments: [clip('a', 10, 9), clip('b', 50, 8)],
      brief: { ...base.brief, targetDurationSec: 15 }
    }
    const short = autoSelect(project)
    expect(short.find((m) => m.id === 'b')).toMatchObject({
      start: 52.5,
      end: 57.5,
      aiStart: 50,
      aiEnd: 60,
      autoTrimmedFrom: { start: 50, end: 60 },
      selected: true
    })
    const longer = {
      ...project,
      moments: short,
      brief: { ...project.brief, targetDurationSec: 30 }
    }
    const long = autoSelect(longer)
    expect(long.find((m) => m.id === 'b')).toEqual({ ...clip('b', 50, 8), selected: true })
  })

  it('takes all strong moments without a target', async () => {
    const project = await reviewProject()
    project.brief.targetDurationSec = null
    const selected = autoSelect(project).filter((m) => m.selected)
    expect(selected.every((m) => m.score >= 7)).toBe(true)
    expect(selected.length).toBe(project.moments.filter((m) => m.score >= 7).length)
  })
})

describe('mock analysis runs', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const settle = async <T>(promise: Promise<T>): Promise<T> => {
    await vi.advanceTimersByTimeAsync(300)
    return promise
  }

  async function mockApi(
    scenario: Parameters<typeof createMockApi>[0]
  ): Promise<{ api: HighlightApi; toasts: string[] }> {
    const { api } = await createMockApi(scenario)
    vi.useFakeTimers()
    const toasts: string[] = []
    api.onToast((event) => toasts.push(event.message))
    return { api, toasts }
  }

  it('lets explicit videos join a running run and rejects everything else, like main', async () => {
    const { api, toasts } = await mockApi('brief')
    const busy = async (promise: Promise<unknown>): Promise<string> => {
      const outcome = promise.then(
        () => 'resolved',
        (err: unknown) => parseIpcError(err).code
      )
      await vi.advanceTimersByTimeAsync(300)
      return outcome
    }
    const id = 'parookaville'
    await settle(api.startAnalysis(id, { videoIds: [`${id}-v1`] }))
    // "Try again" for another video while the run is busy joins it
    await settle(api.startAnalysis(id, { videoIds: [`${id}-v2`] }))
    expect(await busy(api.startAnalysis(id))).toBe('busy')
    expect(await busy(api.startAnalysis(id, { videoIds: [`${id}-v1`] }))).toBe('busy')
    expect(await busy(api.startAnalysis(id, { videoIds: ['nope'] }))).toBe('not-found')

    await advanceUntil(() => toasts.length > 0)
    const project = await settle(api.openProject(id))
    const stages = project.videos.map((v) => project.status[v.id].analysis.stage)
    expect(stages).toEqual(['done', 'done', 'idle', 'idle', 'idle'])
    // one automatic selection at the end of the run: the reel is the automatic one
    expect(project.moments.some((m) => m.selected)).toBe(true)
    expect(project.reelEdited).toBe(false)
  })

  it('keeps a reel edited by hand and offers the new moments as suggestions, like main', async () => {
    const { api, toasts } = await mockApi('review')
    const id = 'parookaville'
    const before = await settle(api.openProject(id))
    expect(before.reelEdited).toBe(true)
    const video = before.videos[1].id
    await settle(api.startAnalysis(id, { videoIds: [video] }))
    await advanceUntil(() => toasts.length > 0)

    const after = await settle(api.openProject(id))
    const replaced = (m: Moment): boolean => m.videoId === video
    expect(after.moments.filter((m) => !replaced(m))).toEqual(
      before.moments.filter((m) => !replaced(m))
    )
    expect(after.moments.filter(replaced)).toHaveLength(5)
    expect(after.moments.filter(replaced).some((m) => m.selected)).toBe(false)
    expect(after.reelEdited).toBe(true)
    expect(toasts.at(-1)).toBe(JOB_MESSAGES.analysisDoneReelKept(5))
  })

  it('puts an edited reel together again when none of its clips is left, like main', async () => {
    const { api, toasts } = await mockApi('review')
    await settle(api.startAnalysis('parookaville', { force: true }))
    await advanceUntil(() => toasts.length > 0)
    const after = await settle(api.openProject('parookaville'))
    expect(after.moments.some((m) => m.selected)).toBe(true)
    expect(after.reelEdited).toBe(false)
    expect(toasts.at(-1)).toBe(JOB_MESSAGES.analysisDone(20, 5))
  })

  it('starts a second pass in one step, like main: the wish joins the brief, every video is analysed again', async () => {
    const { api, toasts } = await mockApi('review')
    const id = 'parookaville'
    const before = await settle(api.openProject(id))
    expect(before.reelEdited).toBe(true)

    // what gets trimmed away does not count for the length, as in main
    await settle(api.analyzeAgain(id, `  More crowd, less stage.${'\n'.repeat(LIMITS.promptMax)}`))
    const started = await settle(api.openProject(id))
    expect(started.brief.prompt).toBe(`${before.brief.prompt.trim()}\nMore crowd, less stage.`)
    // the run puts the reel together anew: it counts as automatic from the start
    expect(started.reelEdited).toBe(false)
    expect(started.videos.map((v) => started.status[v.id].analysis.stage)).not.toContain('done')

    await advanceUntil(() => toasts.length > 0)
    const after = await settle(api.openProject(id))
    expect(after.videos.map((v) => after.status[v.id].analysis.stage)).toEqual(
      after.videos.map(() => 'done')
    )
    const createdBefore = Math.max(
      ...Object.values(before.analyses).map((a) => Date.parse(a.createdAt))
    )
    for (const analysis of Object.values(after.analyses)) {
      expect(Date.parse(analysis.createdAt)).toBeGreaterThan(createdBefore)
    }
    expect(after.moments.some((m) => m.selected)).toBe(true)
    expect(after.reelEdited).toBe(false)
    expect(toasts.at(-1)).toBe(JOB_MESSAGES.analysisDone(20, 5))
  })

  it('protects an edited reel again when a second pass is cancelled before any result, like main', async () => {
    const { api } = await mockApi('review')
    const id = 'parookaville'
    const before = await settle(api.openProject(id))
    expect(before.reelEdited).toBe(true)

    await settle(api.analyzeAgain(id, 'More crowd.'))
    expect((await settle(api.openProject(id))).reelEdited).toBe(false)
    await settle(api.cancelAnalysis(id))
    await vi.advanceTimersByTimeAsync(30_000)

    const after = await settle(api.openProject(id))
    expect(after.videos.map((v) => after.status[v.id].analysis.stage)).not.toContain('done')
    expect(after.moments).toEqual(before.moments)
    expect(after.reelEdited).toBe(true)
  })

  it('refuses a second pass like main – and leaves the brief alone', async () => {
    const { api } = await mockApi('review')
    const id = 'parookaville'
    const before = await settle(api.openProject(id))
    const refused = async (promise: Promise<unknown>): Promise<unknown> => {
      const outcome = promise.then(
        () => 'resolved',
        (err: unknown) => parseIpcError(err)
      )
      await vi.advanceTimersByTimeAsync(300)
      return outcome
    }
    const invalid = { code: 'invalid', message: 'Invalid request. (note)' }
    expect(await refused(api.analyzeAgain(id, ' \n '))).toEqual(invalid)
    expect(await refused(api.analyzeAgain(id, 42 as unknown as string))).toEqual(invalid)
    expect(await refused(api.analyzeAgain(id, 'x'.repeat(LIMITS.promptMax + 1)))).toEqual(invalid)
    const fits = LIMITS.promptMax - before.brief.prompt.trim().length - 1
    expect(await refused(api.analyzeAgain(id, 'x'.repeat(fits + 1)))).toEqual({
      code: 'invalid',
      message: JOB_MESSAGES.wishTooLong
    })
    expect(await refused(api.analyzeAgain('nope', 'More crowd.'))).toMatchObject({
      code: 'not-found'
    })
    expect((await settle(api.openProject(id))).brief).toEqual(before.brief)

    await settle(api.startAnalysis(id, { force: true }))
    expect(await refused(api.analyzeAgain(id, 'More crowd.'))).toEqual({
      code: 'busy',
      message: JOB_MESSAGES.analysisBusy
    })
    expect((await settle(api.openProject(id))).brief).toEqual(before.brief)
  })

  it('needs a key for a second pass, like main', async () => {
    const { api } = await mockApi('keyunreadable')
    const before = await settle(api.openProject('parookaville'))
    const error = await settle(api.analyzeAgain('parookaville', 'More crowd.').catch(parseIpcError))
    expect(error).toEqual({ code: 'no-api-key', message: JOB_MESSAGES.apiKeyUnreadable })
    expect((await settle(api.openProject('parookaville'))).brief).toEqual(before.brief)
  })

  it('finds at most as many moments per video as main lets Gemini return', async () => {
    const { api, toasts } = await mockApi('home')
    await settle(api.startAnalysis('lisboa'))
    await advanceUntil(() => toasts.length > 0)
    const project = await settle(api.openProject('lisboa'))
    for (const video of project.videos) {
      const found = project.moments.filter((m) => m.videoId === video.id).length
      expect(found, video.fileName).toBeGreaterThan(0)
      expect(found, video.fileName).toBeLessThanOrEqual(maxMomentItems(video.durationSec))
    }
  })

  it('does nothing when every video is fresh, like main', async () => {
    const { api, toasts } = await mockApi('review')
    const before = await settle(api.openProject('parookaville'))
    await settle(api.startAnalysis('parookaville'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await settle(api.openProject('parookaville'))).toEqual(before)
    expect(toasts).toEqual([])
  })

  it('makes the reel automatic again on "Auto-select"', async () => {
    const { api } = await mockApi('review')
    const project = await settle(api.autoSelect('parookaville'))
    expect(project.reelEdited).toBe(false)
    expect(project.moments.some((m) => m.selected)).toBe(true)
  })
})

describe('mock parity with main’s new behaviour', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const settle = async <T>(promise: Promise<T>, ms = 1_000): Promise<T> => {
    await vi.advanceTimersByTimeAsync(ms)
    return promise
  }

  async function mockApi(
    scenario: Parameters<typeof createMockApi>[0]
  ): Promise<{ api: HighlightApi; toasts: ToastEvent[] }> {
    const { api } = await createMockApi(scenario)
    vi.useFakeTimers()
    const toasts: ToastEvent[] = []
    api.onToast((event) => toasts.push(event))
    return { api, toasts }
  }

  /** a new project with the given (prepared) files */
  async function projectWith(api: HighlightApi, names: string[]): Promise<Project> {
    const created = await settle(api.createProject('Test'))
    const paths = names.map((name) => `/Users/demo/Movies/Test/${name}`)
    // main reads the files in first, then prepares two at a time
    const adding = api.addVideos(created.id, paths)
    await vi.advanceTimersByTimeAsync(5_000)
    await adding
    await vi.advanceTimersByTimeAsync(20_000)
    return settle(api.openProject(created.id))
  }

  it('sets main’s remedies and fails the rest of the run on a daily quota', async () => {
    const { api, toasts } = await mockApi('home')
    const project = await projectWith(api, [
      'a ok.mp4',
      'b safety.mp4',
      'c quota.mp4',
      'd fail.mp4',
      'e ok.mp4'
    ])
    expect(project.videos.every((v) => project.status[v.id].prepare.status === 'done')).toBe(true)
    await settle(api.startAnalysis(project.id))
    await advanceUntil(() => toasts.some((toast) => toast.level === 'warning'))
    const after = await settle(api.openProject(project.id))
    const byName = (name: string): Project['status'][string]['analysis'] =>
      after.status[after.videos.find((v) => v.fileName.startsWith(name))!.id].analysis
    expect(byName('a').stage).toBe('done')
    expect(byName('b')).toMatchObject({ stage: 'error', remedy: 'none' })
    expect(byName('c')).toMatchObject({ stage: 'error', remedy: 'settings' })
    // ran next to c (two at a time), so it still got its own answer
    expect(byName('d')).toMatchObject({ stage: 'error', remedy: 'retry' })
    // never reached Gemini: the quota was used up
    expect(byName('e')).toMatchObject({
      stage: 'error',
      remedy: 'settings',
      error: byName('c').error
    })
    expect(toasts.map((t) => t.level)).toEqual(['success', 'warning'])
    expect(toasts.at(-1)?.message).toBe(JOB_MESSAGES.analysisFailedMixed(4))
  })

  it('names the shared reason of a partial failure', async () => {
    const { api, toasts } = await mockApi('home')
    const project = await projectWith(api, ['a ok.mp4', 'b fail.mp4', 'c fail.mp4'])
    await settle(api.startAnalysis(project.id))
    await advanceUntil(() => toasts.some((toast) => toast.level === 'warning'))
    // like main: stays until closed, leaves with this project's screens, replaced by the next run's
    expect(toasts.at(-1)).toEqual({
      level: 'warning',
      message: JOB_MESSAGES.analysisPartlyFailed(2, AI_MESSAGES.processing),
      projectId: project.id,
      sticky: true,
      key: TOAST_KEYS.analysisFailed(project.id)
    })
  })

  it('counts videos, not attempts, at the end of a run – like main', async () => {
    const { api, toasts } = await mockApi('home')
    const project = await projectWith(api, ['a fail.mp4', 'b ok.mp4', 'c ok.mp4'])
    const failing = project.videos.find((v) => v.fileName.startsWith('a'))!.id
    let stage = ''
    api.onProjectUpdated((updated) => {
      if (updated.id === project.id) stage = updated.status[failing]?.analysis.stage ?? ''
    })
    await settle(api.startAnalysis(project.id))
    await advanceUntil(() => stage === 'error')
    // "Try again" while c is still being analysed: a joins the run and fails again
    await settle(api.startAnalysis(project.id, { videoIds: [failing] }))
    await advanceUntil(() => toasts.some((toast) => toast.level === 'warning'))
    expect(toasts.map((t) => t.message)).toEqual([
      expect.stringMatching(/^Analysis done: \d+ moments from 2 videos$/),
      JOB_MESSAGES.analysisPartlyFailed(1, AI_MESSAGES.processing)
    ])
  })

  it('analyses a video whose filmstrip failed – the proxy is there, like main', async () => {
    const { api, toasts } = await mockApi('previewfailed')
    const project = await settle(api.openProject('parookaville'))
    const filmstrip = project.videos[2]
    expect(project.status[filmstrip.id].prepare).toMatchObject({
      status: 'error',
      error: MEDIA_MESSAGES.sprite
    })
    expect(filmstrip.proxyPath).not.toBeNull()
    await settle(api.startAnalysis(project.id, { videoIds: [filmstrip.id] }))
    await advanceUntil(() => toasts.length > 0)
    const after = await settle(api.openProject(project.id))
    expect(after.status[filmstrip.id].analysis.stage).toBe('done')
    expect(toasts.map((t) => t.level)).toEqual(['success'])
  })

  it('marks a key Google rejected in an analysis until Google accepts it, like main', async () => {
    const { api, toasts } = await mockApi('home')
    const project = await projectWith(api, ['a auth.mp4'])
    await settle(api.startAnalysis(project.id))
    await advanceUntil(() => toasts.length > 0)
    expect(await settle(api.getSettings())).toMatchObject({ hasApiKey: true, apiKeyRejected: true })
    expect((await settle(api.testApiKey())).ok).toBe(true)
    expect((await settle(api.getSettings())).apiKeyRejected).toBeUndefined()
  })

  it('fails a video without preview right away, with the preview’s reason', async () => {
    const { api, toasts } = await mockApi('previewfailed')
    const project = await settle(api.openProject('parookaville'))
    const gone = project.videos[3]
    await settle(api.startAnalysis(project.id, { videoIds: [gone.id] }))
    await advanceUntil(() => toasts.some((toast) => toast.level === 'error'))
    const after = await settle(api.openProject(project.id))
    expect(after.status[gone.id].analysis).toMatchObject({
      stage: 'error',
      remedy: 'prepare',
      error: JOB_MESSAGES.previewMissing(project.status[gone.id].prepare.error)
    })
    expect(toasts.at(-1)?.level).toBe('error')
  })

  it('reports an unreadable key like main until a new key is stored', async () => {
    const { api } = await mockApi('keyunreadable')
    const settings = await settle(api.getSettings())
    expect(settings).toMatchObject({ hasApiKey: false, apiKeySource: null, apiKeyUnreadable: true })
    const error = await settle(api.startAnalysis('parookaville').catch(parseIpcError))
    expect(error).toEqual({ code: 'no-api-key', message: JOB_MESSAGES.apiKeyUnreadable })
    expect(await settle(api.listModels().catch(parseIpcError))).toEqual({
      code: 'no-api-key',
      message: JOB_MESSAGES.apiKeyUnreadable
    })
    expect(await settle(api.testApiKey())).toEqual({
      ok: false,
      message: JOB_MESSAGES.apiKeyUnreadable
    })
    const rejected = await settle(api.testApiKey('halb-kopiert'))
    expect(rejected).toEqual({ ok: false, message: AI_MESSAGES.keyRejected, rejected: true })
    const stored = await settle(api.updateSettings({ apiKey: 'AIzaSyD-test-key-1234567890abcdef' }))
    expect(stored).toMatchObject({ hasApiKey: true, apiKeySource: 'keychain' })
    expect(stored.apiKeyUnreadable).toBeUndefined()
  })

  it('lets an automatic reel follow a new target length, an edited one stays', async () => {
    const { api } = await mockApi('review')
    const edited = await settle(api.openProject('parookaville'))
    expect(edited.reelEdited).toBe(true)
    const kept = await settle(
      api.mutateProject('parookaville', { type: 'setBrief', patch: { targetDurationSec: 30 } })
    )
    expect(kept.moments).toEqual(edited.moments)

    const automatic = await settle(api.autoSelect('parookaville'))
    const reselected = await settle(
      api.mutateProject('parookaville', { type: 'setBrief', patch: { targetDurationSec: 180 } })
    )
    const count = (p: Project): number => p.moments.filter((m) => m.selected).length
    expect(count(reselected)).toBeGreaterThan(count(automatic))
    expect(reselected.moments).toEqual(autoSelect(reselected))
    expect(reselected.reelEdited).toBe(false)
    // other brief changes leave the reel alone
    const prompt = await settle(
      api.mutateProject('parookaville', { type: 'setBrief', patch: { prompt: 'Only fireworks' } })
    )
    expect(prompt.moments).toEqual(reselected.moments)
  })

  it('starts a new project with the last changed project’s export settings, like main', async () => {
    const first = await settle((await mockApi('nokey')).api.createProject('First'))
    expect(first.exportSettings).toEqual(DEFAULT_EXPORT_SETTINGS)
    vi.useRealTimers()

    const { api } = await mockApi('home')
    const patch = { aspect: '4:5', fit: 'blur', transition: 'crossfade' } as const
    await settle(
      api.mutateProject('lisa', {
        type: 'setExportSettings',
        patch: { ...patch, outputDir: '/Users/demo/Reels' }
      })
    )
    const created = await settle(api.createProject('New'))
    expect(created.exportSettings).toEqual({ ...DEFAULT_EXPORT_SETTINGS, ...patch })
    expect(created.brief).toEqual(DEFAULT_BRIEF)
  })

  it('plays an original by its video id, a missing one fails with main’s text', async () => {
    const { api, toasts } = await mockApi('previewfailed')
    const project = await settle(api.openProject('parookaville'))
    const [first, , , gone] = project.videos
    await settle(api.openOriginal(project.id, first.id))
    expect(toasts.at(-1)?.message).toBe(`Demo mode: “${first.fileName}” would now be played.`)
    expect(await settle(api.openOriginal(project.id, gone.id).catch(parseIpcError))).toEqual({
      code: 'not-found',
      message: JOB_MESSAGES.missingOriginal(gone.fileName)
    })
    expect(await settle(api.openOriginal(project.id, 'v-x').catch(parseIpcError))).toMatchObject({
      code: 'not-found'
    })
  })

  it('expands a dropped folder into its videos, like main', async () => {
    const { api } = await mockApi('home')
    const created = await settle(api.createProject('Folder'))
    const result = api.addVideos(created.id, [
      '/Users/demo/Movies/Festival',
      '/Users/demo/Movies/Empty'
    ])
    await vi.advanceTimersByTimeAsync(10_000)
    const { added, skipped, project } = await result
    expect(added).toBe(3)
    expect(project.videos.every((v) => v.path.startsWith('/Users/demo/Movies/Festival/'))).toBe(
      true
    )
    expect(skipped).toEqual([
      { path: '/Users/demo/Movies/Empty', reason: JOB_MESSAGES.folderWithoutVideos }
    ])
  })

  it('names the log file and a broken ffmpeg like main', async () => {
    const { appInfo } = await buildWorld('ffmpegbroken')
    expect(appInfo.logFile).toMatch(/\/logs\/main\.log$/)
    expect(appInfo.ffmpeg).toMatchObject({
      ok: false,
      ffmpegPath: '/Applications/Glimpse.app/Contents/Resources/ffmpeg/ffmpeg'
    })
    expect(appInfo.ffmpeg.error).toBe(MEDIA_MESSAGES.damagedApp)
  })
})

describe('mock texts and rules are main’s', () => {
  it('shows main’s texts', () => {
    const pairs: [string, string][] = [
      [MOCK_MESSAGES.noApiKey, JOB_MESSAGES.noApiKey],
      [MOCK_MESSAGES.wishTooLong, JOB_MESSAGES.wishTooLong],
      [MOCK_MESSAGES.footageTwice, MUTATION_MESSAGES.footageTwice],
      [MOCK_MESSAGES.keyUnreadable, JOB_MESSAGES.apiKeyUnreadable],
      [MOCK_MESSAGES.keyRejected, AI_MESSAGES.keyRejected],
      [MOCK_MESSAGES.noKeyStored, IPC_MESSAGES.noStoredKey],
      [MOCK_MESSAGES.noKeyForModels, IPC_MESSAGES.noKeyForModels],
      [MOCK_MESSAGES.keyOk(1), AI_MESSAGES.keyOk(1)],
      [MOCK_MESSAGES.keyOk(4), AI_MESSAGES.keyOk(4)],
      [MOCK_MESSAGES.noFfmpeg, MEDIA_MESSAGES.noFfmpeg],
      [MOCK_MESSAGES.damagedApp, MEDIA_MESSAGES.damagedApp],
      [MOCK_MESSAGES.notAVideo, JOB_MESSAGES.notAVideo],
      [MOCK_MESSAGES.alreadyInProject, JOB_MESSAGES.alreadyInProject],
      [MOCK_MESSAGES.emptyFolder, JOB_MESSAGES.folderWithoutVideos],
      [MOCK_MESSAGES.missingOriginal('VID_7.mp4'), JOB_MESSAGES.missingOriginal('VID_7.mp4')],
      [MOCK_MESSAGES.proxyFailed, MEDIA_MESSAGES.proxy],
      [MOCK_MESSAGES.spriteFailed, MEDIA_MESSAGES.sprite],
      [MOCK_MESSAGES.previewMissing('Grund.'), JOB_MESSAGES.previewMissing('Grund.')],
      [MOCK_MESSAGES.quotaMinute, AI_MESSAGES.quotaMinute],
      // the mock's default model is main's default (MOCK_MODELS[0])
      [MOCK_MESSAGES.quotaDay, AI_MESSAGES.quotaDay(dailyQuotaAlternative(MOCK_MODELS[0].id))],
      [MOCK_MESSAGES.auth, AI_MESSAGES.auth],
      [MOCK_MESSAGES.safety, AI_MESSAGES.safety],
      [MOCK_MESSAGES.processing, AI_MESSAGES.processing],
      [MOCK_MESSAGES.retryHint, JOB_MESSAGES.retryHint],
      [MOCK_MESSAGES.exportDone, JOB_MESSAGES.exportDone],
      [MOCK_MESSAGES.exportSaved, JOB_MESSAGES.exportSaved]
    ]
    for (const [mock, main] of pairs) expect(mock).toBe(main)
    for (const n of [0, 1, 7]) {
      expect(MOCK_MESSAGES.momentsFound(n)).toBe(JOB_MESSAGES.momentsFound(n))
      expect(MOCK_MESSAGES.analysisDoneReelKept(n)).toBe(JOB_MESSAGES.analysisDoneReelKept(n))
      expect(MOCK_MESSAGES.analysisDone(n, 1)).toBe(JOB_MESSAGES.analysisDone(n, 1))
      expect(MOCK_MESSAGES.analysisDone(n, 3)).toBe(JOB_MESSAGES.analysisDone(n, 3))
    }
    // the model picker offers main's catalog
    expect(MOCK_MODELS).toEqual(MODEL_CATALOG.map((option) => ({ ...option })))
  })

  it('builds the end-of-run failure toast like main', () => {
    const quota = AI_MESSAGES.quotaDay('Gemini 3.5 Flash-Lite')
    const cases: [Failure[], number][] = [
      [[{ message: AI_MESSAGES.processing, remedy: 'retry' }], 2],
      [[{ message: AI_MESSAGES.processing, remedy: 'retry' }], 0],
      [[{ message: MEDIA_MESSAGES.proxy, remedy: 'retry' }], 1],
      [
        [
          { message: quota, remedy: 'settings' },
          { message: quota, remedy: 'settings' }
        ],
        1
      ],
      [[{ message: quota, remedy: 'settings' }], 0],
      [
        [
          { message: AI_MESSAGES.safety, remedy: 'none' },
          { message: quota, remedy: 'settings' }
        ],
        3
      ],
      [
        [
          { message: AI_MESSAGES.processing, remedy: 'retry' },
          { message: AI_MESSAGES.network, remedy: 'retry' }
        ],
        0
      ],
      [[{ message: JOB_MESSAGES.previewMissing('Weg.'), remedy: 'prepare' }], 4]
    ]
    for (const [failures, succeeded] of cases) {
      const mock = mockFailureToast(
        failures.map((failure) => ({ reason: failure.message, remedy: failure.remedy })),
        succeeded
      )
      expect(mock).toEqual(failureToast(failures, succeeded))
    }
  })

  it('fails the fake analyzer’s trigger files like main: remedy, run end, reason', async () => {
    const analyzer = createFakeAnalyzer({ stageMs: 0 })
    const cases: [string, AnalysisRemedy | null][] = [
      ['Drop quota.mp4', 'settings'],
      ['Login auth.mp4', 'settings'],
      ['Fire safety.mp4', 'none'],
      ['Shaky fail.mp4', 'retry'],
      ['Stage.mp4', null]
    ]
    for (const [fileName, remedy] of cases) {
      const outcome = await analyzer
        .analyze({
          apiKey: 'test-key',
          model: MOCK_MODELS[0].id,
          video: {
            proxyPath: '/tmp/proxy.mp4',
            proxyFingerprint: `fp-${fileName}`,
            durationSec: 60,
            fileName,
            recordedAt: null
          },
          brief: { prompt: 'Drops', targetDurationSec: 60 },
          remoteFile: null,
          onRemoteFile: () => undefined,
          onStage: () => undefined
        })
        .then(
          () => null,
          (err: unknown) => err
        )
      const mock = mockAnalysisFailure(fileName)
      if (remedy === null) {
        expect(outcome, fileName).toBeNull()
        expect(mock, fileName).toBeNull()
        continue
      }
      expect(outcome, fileName).toBeInstanceOf(AnalyzerError)
      expect(analysisRemedy(outcome), fileName).toBe(remedy)
      expect(mock, fileName).toMatchObject({ remedy, fatal: isFatalForRun(outcome) })
      // the fake marks its processing error as a test ("(test mode)"); the mock shows the real text
      const reason = fileName.includes('fail') ? AI_MESSAGES.processing : (outcome as Error).message
      expect(mock?.error, fileName).toBe(reason)
    }
  })
})
