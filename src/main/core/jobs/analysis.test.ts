import { parseIpcError, TOAST_KEYS } from '@shared/ipc'
import { LIMITS } from '@shared/presets'
import type { AnalysisStage, Moment, Project, ProjectMutation } from '@shared/types'
import { readFile, utimes, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnalyzerError, MediaError } from '../../contracts'
import { briefHash } from '../briefHash'
import { CoreError, DISK_FULL_MESSAGE } from '../errors'
import { applyMutation } from '../mutations'
import { idleStatus, makeProject, makeVideo, selectedIds } from '../testing/fixtures'
import type { Gate } from '../testing/gate'
import { createHarness, TEST_API_KEY, type Harness } from '../testing/harness'
import { eventually } from '../testing/helpers'
import { analysisRemedy, isAnalysisFresh } from './analysis'
import { JOB_MESSAGES } from './messages'
import { PreviewMissingError } from './prepare'

let h: Harness

beforeEach(async () => {
  h = await createHarness()
})

afterEach(async () => {
  await h.dispose()
})

const stages = (projectId: string): AnalysisStage[] => {
  const project = h.store.get(projectId)
  return project.videos.map((v) => project.status[v.id].analysis.stage)
}

/** records every analysis stage a video went through (from the store's change events) */
function recordStages(projectId: string): Map<string, AnalysisStage[]> {
  const seen = new Map<string, AnalysisStage[]>()
  h.store.subscribe((event) => {
    if (event.type !== 'updated' || event.project.id !== projectId) return
    for (const [videoId, status] of Object.entries(event.project.status)) {
      const list = seen.get(videoId) ?? []
      if (list.at(-1) !== status.analysis.stage) list.push(status.analysis.stage)
      seen.set(videoId, list)
    }
  })
  return seen
}

async function analyse(
  projectId: string,
  options?: Parameters<Harness['jobs']['startAnalysis']>[1]
): Promise<Project> {
  await h.jobs.startAnalysis(projectId, options)
  await h.jobs.whenIdle()
  return h.store.get(projectId)
}

/** a hand edit as the renderer sends it (mutateProject) */
function edit(projectId: string, mutation: ProjectMutation): Project {
  return h.store.update(projectId, (draft) => applyMutation(draft, mutation))
}

describe('analysis run', () => {
  it('analyses every video and auto-selects afterwards', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4', 'b.mp4'])
    const seen = recordStages(project.id)

    const result = await analyse(project.id)

    expect(h.analyzer.calls).toHaveLength(2)
    const call = h.analyzer.calls.find((c) => c.video.fileName === 'a.mp4')
    expect(call).toMatchObject({
      apiKey: TEST_API_KEY,
      model: 'gemini-test',
      brief: project.brief,
      remoteFile: null,
      video: {
        proxyPath: h.paths.analysisFile(project.id, videoIds[0]),
        fileName: 'a.mp4',
        durationSec: 60
      }
    })
    expect(call?.video.proxyFingerprint).toBe(
      await h.media.fingerprint(h.paths.analysisFile(project.id, videoIds[0]))
    )
    expect(h.media.calls.analysisCopy).toContain(h.paths.proxyFile(project.id, videoIds[0]))

    const hash = briefHash(project.brief, 'gemini-test')
    for (const videoId of videoIds) {
      expect(result.status[videoId].analysis).toMatchObject({
        stage: 'done',
        progress: 1,
        message: '3 moments found'
      })
      expect(result.analyses[videoId]).toMatchObject({
        briefHash: hash,
        model: 'gemini-test'
      })
      expect(result.remoteFiles[videoId].name).toMatch(/^files\//)
      expect(seen.get(videoId)).toEqual(['queued', 'uploading', 'processing', 'analyzing', 'done'])
    }
    expect(result.moments).toHaveLength(6)
    expect(result.moments.every((m) => m.aiStart === m.start && m.aiEnd === m.end)).toBe(true)
    // chronological after autoSelect: video order, then start
    const order = result.moments.map(
      (m) => `${videoIds.indexOf(m.videoId)}:${String(m.start).padStart(3, '0')}`
    )
    expect(order).toEqual([...order].sort())
    expect(result.moments.filter((m) => m.selected).length).toBeGreaterThan(1)
    expect(result.reelEdited).toBe(false)
    expect(h.toasts).toEqual([
      {
        level: 'success',
        message: 'Analysis done: 6 moments from 2 videos',
        projectId: project.id
      }
    ])
  })

  it('never publishes a finished run without its automatic reel', async () => {
    const first = await h.preparedProject(['a.mp4', 'b.mp4', 'c.mp4'])
    const second = await h.preparedProject(['d.mp4', 'e.mp4'])
    const finishedWithoutReel: string[] = []
    h.store.subscribe((event) => {
      if (event.type !== 'updated') return
      const { videos, status, moments } = event.project
      const stages = videos.map((v) => status[v.id].analysis.stage)
      const finished = stages.every((stage) => stage === 'done' || stage === 'error')
      if (finished && !moments.some((m) => m.selected)) finishedWithoutReel.push(stages.join())
    })
    await analyse(first.project.id)
    // the last video's result and the reel arrive in one update – also when that video failed
    h.analyzer.errors.set('e.mp4', new AnalyzerError('safety', 'Rejected.'))
    const failing = h.analyzer.holdVideo('e.mp4')
    await h.jobs.startAnalysis(second.project.id)
    await eventually(() => expect(stages(second.project.id)[0]).toBe('done'))
    failing.release()
    await h.jobs.whenIdle()
    expect(finishedWithoutReel).toEqual([])
    expect(stages(second.project.id)).toEqual(['done', 'error'])
    expect(selectedIds(h.store.get(second.project.id).moments)).toHaveLength(3)
    expect(h.toasts.map((t) => t.level)).toEqual(['success', 'success', 'warning'])
  })

  it('skips fresh videos, re-analyses stale ones and honours force / explicit videos', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4', 'b.mp4'])
    await analyse(project.id)
    expect(h.analyzer.calls).toHaveLength(2)

    await analyse(project.id)
    expect(h.analyzer.calls).toHaveLength(2)
    expect(h.toasts).toHaveLength(1)

    // the remote upload is reused on re-analysis
    h.store.update(project.id, (draft) => void (draft.brief.prompt = 'Only drops'))
    await analyse(project.id)
    expect(h.analyzer.calls).toHaveLength(4)
    const reused = h.analyzer.calls
      .slice(2)
      .map((c) => [c.video.fileName, c.remoteFile?.name])
      .sort()
    expect(reused).toEqual([
      ['a.mp4', 'files/a.mp4'],
      ['b.mp4', 'files/b.mp4']
    ])

    h.settings.settings = { ...h.settings.settings, model: 'gemini-other' }
    await analyse(project.id, { videoIds: [videoIds[1]] })
    expect(h.analyzer.calls.map((c) => c.video.fileName).slice(4)).toEqual(['b.mp4'])

    await analyse(project.id, { force: true })
    expect(h.analyzer.calls).toHaveLength(7)
  })

  it('does nothing when every video is fresh: no error, no toast, the project unchanged', async () => {
    const { project } = await h.preparedProject(['a.mp4', 'b.mp4'])
    await analyse(project.id)
    const before = h.store.get(project.id)
    const toasts = h.toasts.length
    const events: string[] = []
    h.store.subscribe((event) => events.push(event.type))

    // e.g. the renderer's freshness check still saw the previous brief
    await expect(h.jobs.startAnalysis(project.id)).resolves.toBeUndefined()
    await expect(h.jobs.startAnalysis(project.id, { force: false })).resolves.toBeUndefined()
    await h.jobs.whenIdle()
    expect(h.store.get(project.id)).toBe(before)
    expect(events).toEqual([])
    expect(h.toasts).toHaveLength(toasts)
    expect(h.analyzer.calls).toHaveLength(2)
    expect(h.jobs.analysis.isRunning(project.id)).toBe(false)

    // nothing is left behind that would block the next run
    await analyse(project.id, { force: true })
    expect(h.analyzer.calls).toHaveLength(4)
  })

  it('needs an API key unless the fake analyzer is on', async () => {
    const { project } = await h.preparedProject(['a.mp4'])
    h.settings.apiKey = null
    await expect(h.jobs.startAnalysis(project.id)).rejects.toThrow(/no-api-key/)
    h.settings.settings = { ...h.settings.settings, fakeAi: true }
    const result = await analyse(project.id)
    expect(h.analyzer.calls[0].apiKey).toBe('')
    expect(stages(result.id)).toEqual(['done'])
  })

  it('asks for the key again when the stored one cannot be read any more', async () => {
    const { project } = await h.preparedProject(['a.mp4'])
    h.settings.apiKey = null
    h.settings.settings = {
      ...h.settings.settings,
      hasApiKey: false,
      apiKeySource: null,
      apiKeyUnreadable: true
    }
    const err: unknown = await h.jobs.startAnalysis(project.id).catch((e: unknown) => e)
    expect(parseIpcError(err)).toEqual({
      code: 'no-api-key',
      message: 'Your saved API key can no longer be read. Paste it again in Settings.'
    })
    expect(h.analyzer.calls).toEqual([])
  })

  it('reports unknown projects and videos', async () => {
    const { project } = await h.preparedProject(['a.mp4'])
    await expect(h.jobs.startAnalysis('nope')).rejects.toThrow(/not-found/)
    await expect(h.jobs.startAnalysis(project.id, { videoIds: ['nope'] })).rejects.toThrow(
      /not-found/
    )
  })

  it('waits for the proxy before analysing', async () => {
    const gate = h.media.hold('proxy')
    const { id } = await h.store.create('Festival')
    await h.jobs.addVideos(id, [await h.video('a.mp4')])
    await h.jobs.startAnalysis(id)
    await eventually(() => expect(stages(id)).toEqual(['waiting-proxy']))
    expect(h.analyzer.calls).toHaveLength(0)
    gate.release()
    await h.jobs.whenIdle()
    expect(stages(id)).toEqual(['done'])
  })

  it('fails a video without preview right away – without Gemini, with the preview’s reason', async () => {
    const gate = h.analyzer.hold()
    const { id } = await h.store.create('Festival')
    const good = await h.video('a.mp4')
    const broken = await h.video('b.mp4')
    const reason = 'The preview of the video could not be created.'
    h.media.failures.set(broken, { step: 'proxy', error: new MediaError('ffmpeg', reason) })
    await h.jobs.addVideos(id, [good, broken])
    await h.jobs.whenIdle()

    await h.jobs.startAnalysis(id)
    // already failed while the good video is still being analysed
    const brokenId = h.store.get(id).videos.find((v) => v.fileName === 'b.mp4')?.id ?? ''
    expect(h.store.get(id).status[brokenId].analysis).toMatchObject({
      stage: 'error',
      remedy: 'prepare',
      error: `The preview for this video is missing: ${reason}`
    })
    gate.release()
    await h.jobs.whenIdle()
    expect(h.analyzer.calls.map((c) => c.video.fileName)).toEqual(['a.mp4'])
    expect(h.toasts.at(-1)).toEqual({
      level: 'warning',
      message: `1 video could not be analysed: The preview for this video is missing: ${reason}`,
      projectId: id,
      sticky: true,
      key: TOAST_KEYS.analysisFailed(id)
    })
  })

  it('fails a video whose preview fails while the analysis waits for it', async () => {
    const proxyGate = h.media.hold('proxy')
    const { id } = await h.store.create('Festival')
    const file = await h.video('gone.mp4')
    await h.jobs.addVideos(id, [file])
    await h.jobs.startAnalysis(id)
    await eventually(() => expect(stages(id)).toEqual(['waiting-proxy']))
    h.media.failures.set(file, {
      step: 'proxy',
      error: new CoreError('not-found', JOB_MESSAGES.missingOriginal('gone.mp4'))
    })
    proxyGate.release()
    await h.jobs.whenIdle()
    const project = h.store.get(id)
    expect(project.status[project.videos[0].id].analysis).toMatchObject({
      stage: 'error',
      remedy: 'prepare',
      error: `The preview for this video is missing: ${JOB_MESSAGES.missingOriginal('gone.mp4')}`
    })
    expect(h.analyzer.calls).toHaveLength(0)
  })

  it('runs at most 2 analyses in parallel', async () => {
    const gate = h.analyzer.hold()
    const { project } = await h.preparedProject(['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4', 'e.mp4'])
    await h.jobs.startAnalysis(project.id)
    await eventually(() => expect(gate.waiting).toBe(2))
    // time for a third analysis to (wrongly) reach the analyzer
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(gate.waiting).toBe(2)
    expect(stages(project.id).filter((s) => s === 'queued')).toHaveLength(3)
    gate.release()
    await h.jobs.whenIdle()
    expect(h.analyzer.maxParallel).toBe(2)
    expect(stages(project.id)).toEqual(['done', 'done', 'done', 'done', 'done'])
  })

  it('shares the limit between projects and lets them take turns', async () => {
    const a = h.analyzer.holdVideo('a.mp4')
    const b = h.analyzer.holdVideo('b.mp4')
    const first = await h.preparedProject(['a.mp4', 'b.mp4', 'c.mp4'])
    const second = await h.preparedProject(['d.mp4'])
    await h.jobs.startAnalysis(first.project.id)
    await h.jobs.startAnalysis(second.project.id)
    await eventually(() => expect(a.waiting + b.waiting).toBe(2))
    // time for a third analysis to (wrongly) reach the analyzer
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(h.analyzer.calls).toHaveLength(2)
    expect(stages(second.project.id)).toEqual(['queued'])

    // the second project gets the next free slot instead of waiting for the whole first run
    a.release()
    await eventually(() => expect(stages(second.project.id)).toEqual(['done']))
    b.release()
    await h.jobs.whenIdle()
    expect(h.analyzer.maxParallel).toBe(2)
    expect(h.analyzer.calls.map((c) => c.video.fileName).slice(2)).toEqual(['d.mp4', 'c.mp4'])
    expect(stages(first.project.id)).toEqual(['done', 'done', 'done'])
    expect(stages(second.project.id)).toEqual(['done'])
  })
})

describe('isAnalysisFresh', () => {
  it('needs a result for the current hash whose video was not failed or cancelled since', () => {
    const project = (stage: AnalysisStage, hash = 'h1'): Project =>
      makeProject({
        videos: [makeVideo({ id: 'v1' })],
        status: { v1: { ...idleStatus(), analysis: { stage, progress: 0 } } },
        analyses: {
          v1: {
            videoId: 'v1',
            model: 'gemini-test',
            briefHash: hash,
            createdAt: '2026-07-12T20:00:00.000Z'
          }
        }
      })
    expect(isAnalysisFresh(project('done'), 'v1', 'h1')).toBe(true)
    expect(isAnalysisFresh(project('done'), 'v1', 'h2')).toBe(false)
    expect(isAnalysisFresh(project('error'), 'v1', 'h1')).toBe(false)
    expect(isAnalysisFresh(project('cancelled'), 'v1', 'h1')).toBe(false)
    expect(isAnalysisFresh(makeProject({ videos: [makeVideo({ id: 'v1' })] }), 'v1', 'h1')).toBe(
      false
    )
  })
})

describe('analysis control', () => {
  it('rejects a second run, but explicit videos join the running one', async () => {
    const gate = h.analyzer.hold()
    const { project, videoIds } = await h.preparedProject(['a.mp4', 'b.mp4'])
    await h.jobs.startAnalysis(project.id)
    await gate.reached
    await expect(h.jobs.startAnalysis(project.id)).rejects.toThrow(/busy/)
    await expect(h.jobs.startAnalysis(project.id, { videoIds: [videoIds[1]] })).rejects.toThrow(
      /busy/
    )

    const added = await h.jobs.addVideos(project.id, [await h.video('c.mp4')])
    const late = added.project.videos.find((v) => v.fileName === 'c.mp4')?.id ?? ''
    await h.jobs.startAnalysis(project.id, { videoIds: [late] })
    expect(h.store.get(project.id).status[late].analysis.stage).toBe('queued')

    gate.release()
    await h.jobs.whenIdle()
    expect(stages(project.id)).toEqual(['done', 'done', 'done'])
    expect(h.toasts).toEqual([
      {
        level: 'success',
        message: 'Analysis done: 9 moments from 3 videos',
        projectId: project.id
      }
    ])
  })

  it('cancels running and queued videos', async () => {
    const gate = h.analyzer.hold()
    const { project } = await h.preparedProject(['a.mp4', 'b.mp4', 'c.mp4'])
    await h.jobs.startAnalysis(project.id)
    await eventually(() => expect(gate.waiting).toBe(2))
    h.jobs.cancelAnalysis(project.id)
    expect(await h.jobs.whenIdle()).toBe(true)
    const result = h.store.get(project.id)
    expect(stages(project.id)).toEqual(['cancelled', 'cancelled', 'cancelled'])
    expect(
      result.videos.every((v) => result.status[v.id].analysis.message === JOB_MESSAGES.cancelled)
    ).toBe(true)
    // nothing to fix after a cancellation
    expect(result.videos.map((v) => result.status[v.id].analysis.remedy)).toEqual([
      undefined,
      undefined,
      undefined
    ])
    // the third video waited in the queue: Gemini never saw it
    expect(h.analyzer.calls).toHaveLength(2)
    expect(h.analyzer.calls.every((call) => call.signal?.aborted)).toBe(true)
    expect(result.moments).toEqual([])
    expect(h.toasts).toEqual([])
    // a new run can start right away
    gate.release()
    await analyse(project.id)
    expect(stages(project.id)).toEqual(['done', 'done', 'done'])
  })

  it('re-analyses a cancelled video by default, although an older result is still fresh', async () => {
    const { project } = await h.preparedProject(['a.mp4'])
    await analyse(project.id)
    const gate = h.analyzer.hold()
    await h.jobs.startAnalysis(project.id, { force: true })
    await gate.reached
    h.jobs.cancelAnalysis(project.id)
    await h.jobs.whenIdle()
    expect(stages(project.id)).toEqual(['cancelled'])

    gate.release()
    await analyse(project.id)
    expect(h.analyzer.calls).toHaveLength(3)
    expect(stages(project.id)).toEqual(['done'])
    expect(h.toasts.at(-1)).toEqual({
      level: 'success',
      message: JOB_MESSAGES.analysisDone(3, 1),
      projectId: project.id
    })
  })

  it('cancels even when the analyzer ignores its abort signal', async () => {
    const gate = h.analyzer.hold()
    h.analyzer.honourAbort = false
    const { project } = await h.preparedProject(['a.mp4'])
    await h.jobs.startAnalysis(project.id)
    await gate.reached
    h.jobs.cancelAnalysis(project.id)
    expect(await h.jobs.whenIdle(1000)).toBe(true)
    expect(stages(project.id)).toEqual(['cancelled'])
    // the late result is ignored
    gate.release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.store.get(project.id).moments).toEqual([])
    expect(stages(project.id)).toEqual(['cancelled'])
  })

  it('asks for videos first', async () => {
    const { id } = await h.store.create('Empty')
    await expect(h.jobs.startAnalysis(id)).rejects.toThrow(JOB_MESSAGES.noVideos)
  })

  it('marks a failed video with the analyzer’s message and keeps the others', async () => {
    const { project } = await h.preparedProject(['a.mp4', 'b.mp4'])
    h.analyzer.errors.set(
      'b.mp4',
      new AnalyzerError('quota', 'The Gemini quota is used up. Try again later.', {
        retryable: true
      })
    )
    const result = await analyse(project.id)
    expect(stages(project.id)).toEqual(['done', 'error'])
    expect(result.status[result.videos[1].id].analysis).toMatchObject({
      error: 'The Gemini quota is used up. Try again later.',
      remedy: 'retry'
    })
    expect(h.toasts).toEqual([
      {
        level: 'success',
        message: 'Analysis done: 3 moments from 1 video',
        projectId: project.id
      },
      {
        level: 'warning',
        message: '1 video could not be analysed: The Gemini quota is used up. Try again later.',
        // stays until closed, and leaves with this project's screens
        projectId: project.id,
        sticky: true,
        key: TOAST_KEYS.analysisFailed(project.id)
      }
    ])

    // the failed video counts as stale and is picked up by the next run
    h.analyzer.errors.clear()
    await analyse(project.id)
    expect(h.analyzer.calls.map((c) => c.video.fileName).slice(2)).toEqual(['b.mp4'])
  })

  it('stops the run when the API key is rejected', async () => {
    const { project } = await h.preparedProject(['a.mp4', 'b.mp4', 'c.mp4'])
    // the two videos that run at the same time are rejected; the queued one is never sent
    const rejected = new AnalyzerError('auth', 'Google rejected the API key.')
    for (const name of ['a.mp4', 'b.mp4']) h.analyzer.errors.set(name, rejected)
    const result = await analyse(project.id)
    expect(h.analyzer.calls).toHaveLength(2)
    expect(result.videos.map((v) => result.status[v.id].analysis.error)).toEqual(
      Array(3).fill('Google rejected the API key.')
    )
    expect(result.videos.map((v) => result.status[v.id].analysis.remedy)).toEqual(
      Array(3).fill('settings')
    )
    expect(h.toasts).toEqual([
      {
        level: 'error',
        message: JOB_MESSAGES.analysisAllFailed('Google rejected the API key.'),
        projectId: project.id,
        sticky: true,
        key: TOAST_KEYS.analysisFailed(project.id)
      }
    ])
    // Settings shows the key as rejected instead of "Connected"
    expect(h.settings.keyChecks).toEqual(Array(2).fill({ apiKey: TEST_API_KEY, accepted: false }))
  })

  it('stops the run when the daily quota is used up, but not on a per-minute limit', async () => {
    const { project } = await h.preparedProject(['a.mp4', 'b.mp4', 'c.mp4'])
    const daily = 'The daily quota for this model is used up.'
    // the two videos that run at the same time hit the quota; the queued one is never sent
    for (const name of ['a.mp4', 'b.mp4']) {
      h.analyzer.errors.set(name, new AnalyzerError('quota', daily))
    }
    const result = await analyse(project.id)
    expect(h.analyzer.calls).toHaveLength(2)
    expect(result.videos.map((v) => result.status[v.id].analysis.error)).toEqual(
      Array(3).fill(daily)
    )
    expect(result.videos.map((v) => result.status[v.id].analysis.remedy)).toEqual(
      Array(3).fill('settings')
    )

    h.analyzer.errors.clear()
    h.analyzer.errors.set(
      'a.mp4',
      new AnalyzerError('quota', 'Too many requests for a moment.', { retryable: true })
    )
    const second = await analyse(project.id)
    expect(h.analyzer.calls).toHaveLength(5)
    expect(second.videos.map((v) => second.status[v.id].analysis.stage)).toEqual([
      'error',
      'done',
      'done'
    ])
  })

  it('surfaces unexpected errors with a generic message and logs them', async () => {
    const { project } = await h.preparedProject(['a.mp4'])
    h.analyzer.errors.set('a.mp4', new TypeError('x is undefined'))
    const result = await analyse(project.id)
    expect(result.status[result.videos[0].id].analysis).toMatchObject({
      error: JOB_MESSAGES.analysisFailed,
      remedy: 'retry'
    })
    expect(h.log.text()).toContain('x is undefined')
  })

  it('names the shared reason of failed videos, or points to the videos when they differ', async () => {
    const { project } = await h.preparedProject(['a.mp4', 'b.mp4', 'c.mp4'])
    const safety = 'Gemini refused to analyse this video for safety reasons.'
    const network = 'No connection to Gemini. Check your internet connection and try again.'
    h.analyzer.errors.set('b.mp4', new AnalyzerError('safety', safety))
    h.analyzer.errors.set('c.mp4', new AnalyzerError('network', network, { retryable: true }))
    const result = await analyse(project.id)
    expect(result.videos.map((v) => result.status[v.id].analysis.remedy)).toEqual([
      undefined,
      'none',
      'retry'
    ])
    expect(h.toasts.at(-1)).toEqual({
      level: 'warning',
      message: '2 videos could not be analysed. The reason is shown at each video.',
      projectId: project.id,
      sticky: true,
      key: TOAST_KEYS.analysisFailed(project.id)
    })

    // every reason can be retried: say so
    h.analyzer.errors.set(
      'b.mp4',
      new AnalyzerError('invalid-response', 'Gemini did not return a usable answer.', {
        retryable: true
      })
    )
    await analyse(project.id, { force: true })
    expect(h.toasts.at(-1)?.message).toBe(
      '2 videos could not be analysed. The reason is shown at each video. You can try again.'
    )

    // one reason for all: name it; the hint only when the reason itself does not offer it
    h.analyzer.errors.set('b.mp4', new TypeError('bug'))
    h.analyzer.errors.set('c.mp4', new TypeError('bug'))
    await analyse(project.id, { force: true })
    expect(h.toasts.at(-1)).toMatchObject({
      level: 'warning',
      message:
        `2 videos could not be analysed: ${JOB_MESSAGES.analysisFailed} ` + 'You can try again.'
    })
    h.analyzer.errors.set('b.mp4', new AnalyzerError('network', network, { retryable: true }))
    h.analyzer.errors.set('c.mp4', new AnalyzerError('network', network, { retryable: true }))
    await analyse(project.id, { force: true })
    expect(h.toasts.at(-1)?.message).toBe(`2 videos could not be analysed: ${network}`)

    // nothing worked: the reason, or the pointer to the videos
    h.analyzer.errors.set('a.mp4', new AnalyzerError('safety', safety))
    await analyse(project.id, { force: true })
    expect(h.toasts.at(-1)).toMatchObject({
      level: 'error',
      message: '3 videos could not be analysed. The reason is shown at each video.'
    })
  })

  describe('the end of a run counts videos, not attempts', () => {
    const PROCESSING = 'Gemini could not process the video. Try again.'
    const processingError = (): AnalyzerError =>
      new AnalyzerError('processing', PROCESSING, { retryable: true })

    /** a.mp4 keeps the run going until released; b.mp4 fails until the error is cleared */
    async function runWithFailingB(): Promise<{ projectId: string; b: string; a: Gate }> {
      const { project, videoIds } = await h.preparedProject(['a.mp4', 'b.mp4'])
      const a = h.analyzer.holdVideo('a.mp4')
      h.analyzer.errors.set('b.mp4', processingError())
      await h.jobs.startAnalysis(project.id)
      await eventually(() => expect(stages(project.id)).toEqual(['analyzing', 'error']))
      return { projectId: project.id, b: videoIds[1], a }
    }

    it('forgets a failure once "Try again" worked while the run was still going', async () => {
      const { projectId, b, a } = await runWithFailingB()
      // "Try again" in b's row: b joins the running run and works this time
      h.analyzer.errors.delete('b.mp4')
      await h.jobs.startAnalysis(projectId, { videoIds: [b] })
      await eventually(() => expect(stages(projectId)).toEqual(['analyzing', 'done']))
      a.release()
      await h.jobs.whenIdle()
      expect(stages(projectId)).toEqual(['done', 'done'])
      expect(h.toasts).toEqual([
        { level: 'success', message: JOB_MESSAGES.analysisDone(6, 2), projectId }
      ])
    })

    it('reports a video that failed three times in one run as one video', async () => {
      const { projectId, b, a } = await runWithFailingB()
      for (let attempt = 2; attempt <= 3; attempt++) {
        await h.jobs.startAnalysis(projectId, { videoIds: [b] })
        await eventually(() => {
          expect(h.analyzer.calls.filter((c) => c.video.fileName === 'b.mp4')).toHaveLength(attempt)
          expect(stages(projectId)).toEqual(['analyzing', 'error'])
        })
      }
      a.release()
      await h.jobs.whenIdle()
      expect(h.toasts.map((t) => t.message)).toEqual([
        JOB_MESSAGES.analysisDone(3, 1),
        `1 video could not be analysed: ${PROCESSING}`
      ])
    })

    it('leaves a failed video out once it was removed', async () => {
      const { projectId, b, a } = await runWithFailingB()
      await h.jobs.removeVideo(projectId, b)
      a.release()
      await h.jobs.whenIdle()
      expect(h.toasts).toEqual([
        { level: 'success', message: JOB_MESSAGES.analysisDone(3, 1), projectId }
      ])
    })
  })

  it('tells the settings that Google accepted the key (a rejection is tested above)', async () => {
    const { project } = await h.preparedProject(['a.mp4'])
    await analyse(project.id)
    expect(h.settings.keyChecks).toEqual([{ apiKey: TEST_API_KEY, accepted: true }])
  })

  it('replaces only the moments of re-analysed videos', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4', 'b.mp4'])
    await analyse(project.id)
    const before = h.store
      .get(project.id)
      .moments.filter((m) => m.videoId === videoIds[1])
      .map((m) => m.id)
    h.analyzer.results.set('a.mp4', [
      { start: 10, end: 16, title: 'New', reason: 'Newly found.', score: 8 }
    ])

    const result = await analyse(project.id, { videoIds: [videoIds[0]] })
    const ofA = result.moments.filter((m) => m.videoId === videoIds[0])
    expect(ofA.map((m) => m.title)).toEqual(['New'])
    expect(result.moments.filter((m) => m.videoId === videoIds[1]).map((m) => m.id)).toEqual(before)
    expect(result.status[videoIds[0]].analysis.message).toBe('1 moment found')
  })

  it('cleans analyzer output: clamps to the video, drops too-short moments', async () => {
    const { project } = await h.preparedProject(['a.mp4'])
    h.analyzer.results.set('a.mp4', [
      { start: -5, end: 3.333, title: '  Start  ', reason: 'r', score: 11.4 },
      { start: 20, end: 20.2, title: 'too short', reason: 'r', score: 7 },
      { start: 58, end: 75, title: '', reason: 'r', score: 0 }
    ])
    const result = await analyse(project.id)
    expect(result.moments.map((m) => [m.start, m.end, m.title, m.score])).toEqual([
      [0, 3.33, 'Start', 10],
      [58, 60, 'Moment', 1]
    ])
  })
})

describe('analysis and a reel edited by hand', () => {
  const ofVideo = (project: Project, videoId: string): Moment[] =>
    project.moments.filter((m) => m.videoId === videoId)

  it('keeps selection, order and trims; the new moments wait unselected as suggestions', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4', 'b.mp4', 'c.mp4'])
    const [a, b, c] = videoIds
    const label = (m: Moment): string => `${'abc'[videoIds.indexOf(m.videoId)]}${m.start}`
    // three 4-second moments per video (at 12, 30 and 48 s) – all fit the 60 s target
    const analysed = await analyse(project.id)
    expect(analysed.reelEdited).toBe(false)
    expect(selectedIds(analysed.moments)).toHaveLength(9)

    // C's first clip opens the reel, A's last one is out, A's middle one trimmed
    edit(project.id, { type: 'reorderMoment', momentId: ofVideo(analysed, c)[0].id, toIndex: 0 })
    edit(project.id, {
      type: 'toggleMoment',
      momentId: ofVideo(analysed, a)[2].id,
      selected: false
    })
    const trimmed = ofVideo(analysed, a)[1].id
    const edited = edit(project.id, {
      type: 'updateMomentTimes',
      momentId: trimmed,
      start: 30.5,
      end: 34
    })
    expect(edited.reelEdited).toBe(true)
    expect(edited.moments.map(label)).toEqual([
      'c12',
      'a12',
      'a30.5',
      'a48',
      'b12',
      'b30',
      'b48',
      'c30',
      'c48'
    ])
    h.analyzer.results.set('b.mp4', [
      { start: 2, end: 8, title: 'New early', reason: 'New.', score: 9 },
      { start: 40, end: 46, title: 'New late', reason: 'New.', score: 8 }
    ])

    const result = await analyse(project.id, { videoIds: [b] })

    // everything that was not replaced keeps its selection, its place and its times
    const replaced = (m: Moment): boolean => m.videoId === b
    expect(result.moments.filter((m) => !replaced(m))).toEqual(
      edited.moments.filter((m) => !replaced(m))
    )
    expect(result.moments.find((m) => m.id === trimmed)).toMatchObject({ start: 30.5, end: 34 })
    expect(result.reelEdited).toBe(true)
    // B's old clips left the reel; the new ones wait unselected next to their neighbours
    expect(result.moments.map(label)).toEqual([
      'c12',
      'a12',
      'a30.5',
      'a48',
      'b2',
      'b40',
      'c30',
      'c48'
    ])
    expect(ofVideo(result, b).map((m) => [m.title, m.selected, m.aiStart, m.aiEnd])).toEqual([
      ['New early', false, 2, 8],
      ['New late', false, 40, 46]
    ])
    expect(result.moments.filter((m) => m.selected).map(label)).toEqual([
      'c12',
      'a12',
      'a30.5',
      'c30',
      'c48'
    ])
    expect(h.toasts.at(-1)).toEqual({
      level: 'success',
      message:
        'Analysis done: 2 new suggestions. Your selection stays. You can find the new moments ' +
        'under “More suggestions”.',
      projectId: project.id
    })
  })

  it('decides at the end of the run: an edit made meanwhile keeps the reel', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4', 'b.mp4'])
    const analysed = await analyse(project.id)
    const gate = h.analyzer.hold()
    await h.jobs.startAnalysis(project.id, { videoIds: [videoIds[0]] })
    await gate.reached
    const removed = ofVideo(analysed, videoIds[1])[0].id
    edit(project.id, { type: 'toggleMoment', momentId: removed, selected: false })
    gate.release()
    await h.jobs.whenIdle()

    const result = h.store.get(project.id)
    expect(result.reelEdited).toBe(true)
    expect(result.moments.find((m) => m.id === removed)?.selected).toBe(false)
    // B's other clips stay in the reel, A's new moments wait as suggestions
    expect(selectedIds(result.moments)).toEqual(
      ofVideo(analysed, videoIds[1])
        .slice(1)
        .map((m) => m.id)
    )
    expect(h.toasts.at(-1)?.message).toBe(JOB_MESSAGES.analysisDoneReelKept(3))
  })

  it('rebuilds an edited reel automatically when the run would leave it without a clip', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4', 'b.mp4'])
    const analysed = await analyse(project.id)
    const gate = h.analyzer.hold()
    await h.jobs.startAnalysis(project.id, { force: true })
    await gate.reached
    const removed = ofVideo(analysed, videoIds[0])[0].id
    edit(project.id, { type: 'toggleMoment', momentId: removed, selected: false })
    gate.release()
    await h.jobs.whenIdle()

    // every AI moment was replaced: an empty reel would be left – it is selected anew
    const result = h.store.get(project.id)
    expect(result.moments.some((m) => m.id === removed)).toBe(false)
    expect(result.moments).toHaveLength(6)
    expect(result.reelEdited).toBe(false)
    expect(selectedIds(result.moments)).toHaveLength(6)
    expect(h.toasts.at(-1)).toEqual({
      level: 'success',
      message: JOB_MESSAGES.analysisDone(6, 2),
      projectId: project.id
    })
  })

  it('keeps the reel of a cancelled run, too – without a toast', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4', 'b.mp4'])
    const analysed = await analyse(project.id)
    const edited = edit(project.id, {
      type: 'toggleMoment',
      momentId: ofVideo(analysed, videoIds[1])[0].id,
      selected: false
    })
    const toasts = h.toasts.length
    h.analyzer.results.set('a.mp4', [
      { start: 20, end: 24, title: 'New', reason: 'New.', score: 10 }
    ])
    // a.mp4 gets analysed; b.mp4 is held at a gate and the run cancelled there
    const held = h.analyzer.holdVideo('b.mp4')
    await h.jobs.startAnalysis(project.id, { force: true })
    await eventually(() => {
      expect(stages(project.id)[0]).toBe('done')
      expect(held.waiting).toBe(1)
    })
    h.jobs.cancelAnalysis(project.id)
    await h.jobs.whenIdle()
    const result = h.store.get(project.id)

    expect(stages(project.id)).toEqual(['done', 'cancelled'])
    expect(result.reelEdited).toBe(true)
    expect(ofVideo(result, videoIds[0]).map((m) => [m.title, m.selected])).toEqual([['New', false]])
    expect(ofVideo(result, videoIds[1])).toEqual(ofVideo(edited, videoIds[1]))
    expect(h.toasts).toHaveLength(toasts)
  })

  it('rebuilds the reel again once "Auto-select" reset the flag', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4', 'b.mp4'])
    const analysed = await analyse(project.id)
    edit(project.id, { type: 'toggleMoment', momentId: analysed.moments[0].id, selected: false })
    const reselected = h.jobs.autoSelect(project.id)
    expect(reselected.reelEdited).toBe(false)
    expect(selectedIds(reselected.moments)).toHaveLength(6)

    h.analyzer.results.set('b.mp4', [{ start: 2, end: 8, title: 'New', reason: 'New.', score: 9 }])
    const result = await analyse(project.id, { videoIds: [videoIds[1]] })
    expect(result.reelEdited).toBe(false)
    expect(result.moments.find((m) => m.title === 'New')?.selected).toBe(true)
    expect(h.toasts.at(-1)?.message).toBe(JOB_MESSAGES.analysisDone(1, 1))
  })

  it('says what happened to the reel, with the right number', () => {
    expect(JOB_MESSAGES.analysisDoneReelKept(7)).toBe(
      'Analysis done: 7 new suggestions. Your selection stays. You can find the new moments ' +
        'under “More suggestions”.'
    )
    expect(JOB_MESSAGES.analysisDoneReelKept(1)).toBe(
      'Analysis done: 1 new suggestion. Your selection stays. You can find the new moment ' +
        'under “More suggestions”.'
    )
    expect(JOB_MESSAGES.analysisDoneReelKept(0)).toBe(
      'Analysis done: no new suggestions. Your selection stays.'
    )
  })
})

describe('analysisRemedy', () => {
  it('says what can help after each kind of error', () => {
    const error = (code: AnalyzerError['code'], retryable = false): AnalyzerError =>
      new AnalyzerError(code, 'Text.', { retryable })
    expect(analysisRemedy(error('auth'))).toBe('settings')
    expect(analysisRemedy(error('model'))).toBe('settings')
    // daily quota, paid-only model, empty prepaid balance
    expect(analysisRemedy(error('quota'))).toBe('settings')
    expect(analysisRemedy(error('quota', true))).toBe('retry')
    for (const code of ['network', 'upload', 'processing', 'invalid-response'] as const) {
      expect(analysisRemedy(error(code, true))).toBe('retry')
    }
    expect(analysisRemedy(error('unknown'))).toBe('retry')
    expect(analysisRemedy(error('safety'))).toBe('none')
    expect(analysisRemedy(new TypeError('bug'))).toBe('retry')
    expect(analysisRemedy(new PreviewMissingError('Broken.'))).toBe('prepare')
  })
})

describe('uploads on Google’s side', () => {
  const ref = (projectId: string, videoId: string): string | undefined =>
    h.store.get(projectId).remoteFiles[videoId]?.name

  it('records an upload as soon as it is active – a failed analysis keeps it for a retry', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4'])
    h.analyzer.errors.set('a.mp4', new AnalyzerError('safety', 'Rejected.'))
    const gate = h.analyzer.hold()
    await h.jobs.startAnalysis(project.id)
    await gate.reached
    // known (and saved) before Gemini has answered
    expect(ref(project.id, videoIds[0])).toBe('files/a.mp4')
    gate.release()
    await h.jobs.whenIdle()
    expect(ref(project.id, videoIds[0])).toBe('files/a.mp4')
    expect(h.analyzer.deleted).toEqual([])

    // saved: an app restart can reuse it as well
    await h.store.flush()
    const saved = JSON.parse(await readFile(h.paths.projectFile(project.id), 'utf8')) as Project
    expect(saved.remoteFiles[videoIds[0]].name).toBe('files/a.mp4')
    h.analyzer.errors.clear()
    await analyse(project.id)
    expect(h.analyzer.calls.at(-1)?.remoteFile?.name).toBe('files/a.mp4')
    expect(h.analyzer.uploads.map((file) => file.name)).toEqual(['files/a.mp4'])

    // removing the video removes its upload
    await h.jobs.removeVideo(project.id, videoIds[0])
    await h.jobs.whenIdle()
    expect(h.analyzer.deleted).toEqual(['files/a.mp4'])
  })

  it('deletes the upload of a cancelled analysis together with its project', async () => {
    const { project } = await h.preparedProject(['a.mp4', 'b.mp4'])
    const gate = h.analyzer.hold()
    await h.jobs.startAnalysis(project.id)
    await eventually(() => expect(gate.waiting).toBe(2))
    await h.jobs.deleteProject(project.id)
    await h.jobs.whenIdle()
    expect([...h.analyzer.deleted].sort()).toEqual(['files/a.mp4', 'files/b.mp4'])
  })

  it('deletes an upload that is reported after its video was removed', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4'])
    h.analyzer.honourAbort = false
    const upload = h.analyzer.holdUpload()
    await h.jobs.startAnalysis(project.id)
    await upload.reached
    await h.jobs.removeVideo(project.id, videoIds[0])
    // the analyzer did not notice the cancellation and finishes its upload
    upload.release()
    await eventually(() => expect(h.analyzer.deleted).toEqual(['files/a.mp4']))
    expect(h.store.get(project.id).remoteFiles).toEqual({})
  })

  it('deletes an upload that is reported while its project is being deleted', async () => {
    const { project } = await h.preparedProject(['a.mp4'])
    h.analyzer.honourAbort = false
    const upload = h.analyzer.holdUpload()
    await h.jobs.startAnalysis(project.id)
    await upload.reached
    const deleting = h.jobs.deleteProject(project.id)
    upload.release()
    await deleting
    await eventually(() => expect(h.analyzer.deleted).toEqual(['files/a.mp4']))
  })

  it('deletes the old upload when a new one replaces it', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4'])
    await analyse(project.id)
    expect(ref(project.id, videoIds[0])).toBe('files/a.mp4')
    // a rebuilt preview has another fingerprint: it is uploaded again
    await writeFile(h.paths.proxyFile(project.id, videoIds[0]), 'a new proxy')
    await analyse(project.id, { force: true })
    expect(ref(project.id, videoIds[0])).toBe('files/a.mp4-2')
    expect(h.analyzer.deleted).toEqual(['files/a.mp4'])
  })

  it('never deletes an upload that another project still uses', async () => {
    const first = await h.preparedProject(['a.mp4'])
    await analyse(first.project.id)
    const shared = h.store.get(first.project.id).remoteFiles[first.videoIds[0]]
    const second = await h.preparedProject(['c.mp4'])
    h.store.update(second.project.id, (draft) => {
      draft.remoteFiles[second.videoIds[0]] = shared
    })
    await h.jobs.removeVideo(first.project.id, first.videoIds[0])
    await h.jobs.whenIdle()
    expect(h.analyzer.deleted).toEqual([])
    await h.jobs.deleteProject(second.project.id)
    await h.jobs.whenIdle()
    expect(h.analyzer.deleted).toEqual(['files/a.mp4'])
  })

  it('lets the app wait for uploads that are being deleted before it quits', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4'])
    await analyse(project.id)
    const deleting = h.analyzer.holdDeletes()
    await h.jobs.removeVideo(project.id, videoIds[0])
    await deleting.reached
    expect(await h.jobs.whenIdle(50)).toBe(false)
    deleting.release()
    expect(await h.jobs.whenIdle()).toBe(true)
    expect(h.analyzer.deleted).toEqual(['files/a.mp4'])
  })

  it('waits on quit for the analyzer deleting an upload Gemini was still processing', async () => {
    const { project } = await h.preparedProject(['a.mp4'])
    const processing = h.analyzer.holdProcessing()
    const deleting = h.analyzer.holdDeletes()
    await h.jobs.startAnalysis(project.id)
    await processing.reached
    // core never heard of this upload (it is not ACTIVE yet): only the analyzer can delete it
    expect(h.store.get(project.id).remoteFiles).toEqual({})

    // what shutdown() does
    h.jobs.cancelAll()
    expect(await h.jobs.whenIdle(50)).toBe(false)
    await deleting.reached
    deleting.release()
    expect(await h.jobs.whenIdle()).toBe(true)
    expect(h.analyzer.discarded).toEqual(['files/a.mp4'])
    expect(stages(project.id)).toEqual(['cancelled'])
  })
})

describe('analysis copy (what Gemini gets)', () => {
  it('is made once, reused on re-analysis and made again when the proxy is newer', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4'])
    await analyse(project.id)
    await analyse(project.id, { force: true })
    expect(h.media.calls.analysisCopy).toHaveLength(1)
    expect(h.analyzer.uploads).toHaveLength(1)
    const later = new Date(Date.now() + 60_000)
    await utimes(h.paths.proxyFile(project.id, videoIds[0]), later, later)
    await analyse(project.id, { force: true })
    expect(h.media.calls.analysisCopy).toHaveLength(2)
  })

  it('shows the upload stage while it is made and stops with a cancel', async () => {
    const { project } = await h.preparedProject(['a.mp4'])
    const copying = h.media.hold('analysisCopy')
    await h.jobs.startAnalysis(project.id)
    await copying.reached
    expect(stages(project.id)).toEqual(['uploading'])
    // 0, not -1: the upload's own first tick (0) must not move the overall bar backwards
    const [videoId] = h.store.get(project.id).videos.map((v) => v.id)
    expect(h.store.get(project.id).status[videoId].analysis.progress).toBe(0)
    h.jobs.cancelAnalysis(project.id)
    expect(await h.jobs.whenIdle()).toBe(true)
    expect(stages(project.id)).toEqual(['cancelled'])
    expect(h.analyzer.calls).toEqual([])
  })

  it('replaces a kept upload of the proxy once (projects from before the copy)', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4'])
    const proxyFingerprint = await h.media.fingerprint(h.paths.proxyFile(project.id, videoIds[0]))
    h.store.update(project.id, (draft) => {
      draft.remoteFiles[videoIds[0]] = {
        name: 'files/old-proxy',
        uri: 'https://example.invalid/old',
        mimeType: 'video/mp4',
        expiresAt: '2026-07-14T20:00:00.000Z',
        proxyFingerprint
      }
    })
    await analyse(project.id)
    expect(h.analyzer.uploads).toHaveLength(1)
    expect(h.analyzer.deleted).toEqual(['files/old-proxy'])
    expect(h.store.get(project.id).remoteFiles[videoIds[0]].proxyFingerprint).toBe(
      await h.media.fingerprint(h.paths.analysisFile(project.id, videoIds[0]))
    )
  })

  it('reports a full disk instead of making the copy', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4'])
    h.disk.free = 1024
    const result = await analyse(project.id)
    expect(result.status[videoIds[0]].analysis).toMatchObject({
      stage: 'error',
      error: DISK_FULL_MESSAGE
    })
    expect(h.media.calls.analysisCopy).toEqual([])
    expect(h.analyzer.calls).toEqual([])
  })
})

describe('second pass ("Ask Gemini again")', () => {
  const again = async (projectId: string, wish: string): Promise<Project> => {
    await h.jobs.analyzeAgain(projectId, wish)
    await h.jobs.whenIdle()
    return h.store.get(projectId)
  }
  const callsFor = (fileName: string): typeof h.analyzer.calls =>
    h.analyzer.calls.filter((call) => call.video.fileName === fileName)
  /** the three default moments of the fake analyzer, as Gemini chose them */
  const gemini = (inReel: boolean[]): unknown[] =>
    [12, 30, 48].map((start, i) => ({
      start,
      end: start + 4,
      title: `Moment ${i + 1}`,
      score: 9 - 2 * i,
      inReel: inReel[i]
    }))

  it('adds the wish to the brief, analyses every video again and shows Gemini its earlier clips', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4', 'b.mp4'])
    const [a, b] = videoIds
    const analysed = await analyse(project.id)
    const ofA = analysed.moments.filter((m) => m.videoId === a)
    // by hand: a's first clip trimmed, its last one out; b has an own clip of an old project
    edit(project.id, { type: 'updateMomentTimes', momentId: ofA[0].id, start: 13, end: 15 })
    edit(project.id, { type: 'toggleMoment', momentId: ofA[2].id, selected: false })
    h.store.update(project.id, (draft) => {
      draft.moments.push({
        id: 'own',
        videoId: b,
        start: 55,
        end: 58,
        title: 'Own clip',
        reason: '',
        score: 10,
        selected: true
      })
    })
    // a video that was never analysed has no earlier clips
    await h.jobs.addVideos(project.id, [await h.video('c.mp4')])
    const before = h.store.get(project.id)
    expect(before.reelEdited).toBe(true)
    h.analyzer.calls.length = 0
    h.toasts.length = 0

    const result = await again(project.id, '  More crowd, less stage.\n')

    const prompt = `${project.brief.prompt}\nMore crowd, less stage.`
    expect(result.brief).toEqual({ ...project.brief, prompt })
    expect(h.analyzer.calls.map((call) => call.video.fileName).sort()).toEqual([
      'a.mp4',
      'b.mp4',
      'c.mp4'
    ])
    for (const call of h.analyzer.calls) expect(call.brief.prompt).toBe(prompt)
    // Gemini's own times (not the trim), and whether the clip was in the highlight video
    expect(callsFor('a.mp4')[0].earlierClips).toEqual(gemini([true, true, false]))
    // b's old own clip has no times of Gemini: listed with its own, like every other clip
    expect(callsFor('b.mp4')[0].earlierClips).toEqual([
      ...gemini([true, true, true]),
      { start: 55, end: 58, title: 'Own clip', score: 10, inReel: true }
    ])
    expect(callsFor('c.mp4')[0].earlierClips).toBeUndefined()
    // the uploads of the first run are used again
    expect(h.analyzer.uploads.map((file) => file.name).sort()).toEqual([
      'files/a.mp4',
      'files/b.mp4',
      'files/c.mp4'
    ])

    // everything Gemini suggested before is replaced, the trim is gone, the reel is put together anew
    const earlierIds = new Set(before.moments.map((m) => m.id))
    expect(result.moments.filter((m) => earlierIds.has(m.id))).toEqual([])
    expect(result.moments.filter((m) => m.videoId === a).map((m) => [m.start, m.end])).toEqual([
      [12, 16],
      [30, 34],
      [48, 52]
    ])
    const hash = briefHash(result.brief, 'gemini-test')
    for (const videoId of result.videos.map((v) => v.id)) {
      expect(result.analyses[videoId].briefHash).toBe(hash)
    }
    expect(result.reelEdited).toBe(false)
    expect(result.moments.filter((m) => m.selected)).not.toHaveLength(0)
    expect(h.toasts).toEqual([
      { level: 'success', message: JOB_MESSAGES.analysisDone(9, 3), projectId: project.id }
    ])
  })

  it('reads the earlier clips before the run replaces anything; a later normal run gets none', async () => {
    const { project } = await h.preparedProject(['a.mp4', 'b.mp4', 'c.mp4'])
    await analyse(project.id)
    h.analyzer.calls.length = 0
    h.analyzer.results.set('a.mp4', [{ start: 1, end: 5, title: 'New', reason: 'New.', score: 8 }])
    // two videos run at a time: c starts after a was replaced, fails, and is queued again – as is
    // a, whose clips the run has replaced by then – while b still keeps the run going
    const held = h.analyzer.holdVideo('b.mp4')
    h.analyzer.errors.set('c.mp4', new AnalyzerError('network', 'No connection.'))
    await h.jobs.analyzeAgain(project.id, 'More crowd.')
    await eventually(() => expect(stages(project.id)).toEqual(['done', 'analyzing', 'error']))
    h.analyzer.errors.delete('c.mp4')
    expect(h.store.get(project.id).moments.map((m) => m.title)).toContain('New')
    const [a, , c] = h.store.get(project.id).videos.map((video) => video.id)
    await h.jobs.startAnalysis(project.id, { videoIds: [a, c] })
    await eventually(() => {
      expect(callsFor('a.mp4')).toHaveLength(2)
      expect(stages(project.id)).toEqual(['done', 'analyzing', 'done'])
    })
    held.release()
    await h.jobs.whenIdle()

    const all = [true, true, true]
    // a's second request shows its clips from before the run, not the run's own "New"
    expect(callsFor('a.mp4').map((call) => call.earlierClips)).toEqual([gemini(all), gemini(all)])
    expect(callsFor('c.mp4').map((call) => call.earlierClips)).toEqual([gemini(all), gemini(all)])
    expect(callsFor('b.mp4')[0].earlierClips).toEqual(gemini(all))

    h.analyzer.calls.length = 0
    await analyse(project.id, { force: true })
    expect(h.analyzer.calls).toHaveLength(3)
    for (const call of h.analyzer.calls) expect(call.earlierClips).toBeUndefined()
  })

  it('does not start – and changes nothing – without videos, without a key, during a run or with a wish that does not fit', async () => {
    const empty = await h.store.create('Empty')
    await expect(h.jobs.analyzeAgain(empty.id, 'More crowd.')).rejects.toThrow(
      JOB_MESSAGES.noVideos
    )
    expect(h.store.get(empty.id).brief).toEqual(empty.brief)

    const { project } = await h.preparedProject(['a.mp4'])
    const analysed = await analyse(project.id)
    const untouched = (): void => {
      const now = h.store.get(project.id)
      expect(now.brief).toEqual(analysed.brief)
      expect(now.moments).toEqual(analysed.moments)
      expect(now.reelEdited).toBe(analysed.reelEdited)
    }

    h.settings.apiKey = null
    await expect(h.jobs.analyzeAgain(project.id, 'More crowd.')).rejects.toThrow(/no-api-key/)
    h.settings.apiKey = TEST_API_KEY
    untouched()

    const fits = LIMITS.promptMax - analysed.brief.prompt.length - 1
    const tooLong = await h.jobs.analyzeAgain(project.id, 'x'.repeat(fits + 1)).catch(parseIpcError)
    expect(tooLong).toEqual({ code: 'invalid', message: JOB_MESSAGES.wishTooLong })
    untouched()
    expect(h.analyzer.calls).toHaveLength(1)

    const gate = h.analyzer.hold()
    await h.jobs.startAnalysis(project.id, { force: true })
    await gate.reached
    await expect(h.jobs.analyzeAgain(project.id, 'More crowd.')).rejects.toThrow(/busy/)
    expect(h.store.get(project.id).brief).toEqual(analysed.brief)
    gate.release()
    await h.jobs.whenIdle()

    // a wish that just fits starts the run
    const result = await again(project.id, 'x'.repeat(fits))
    expect(result.brief.prompt).toHaveLength(LIMITS.promptMax)
    expect(h.analyzer.calls).toHaveLength(3)
  })

  it('cancelled: the wish stays, analysed videos are replaced, the others keep their clips', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4', 'b.mp4'])
    const analysed = await analyse(project.id)
    edit(project.id, { type: 'toggleMoment', momentId: analysed.moments[0].id, selected: false })
    const before = h.store.get(project.id)
    h.toasts.length = 0
    h.analyzer.results.set('a.mp4', [
      { start: 20, end: 24, title: 'New', reason: 'New.', score: 10 }
    ])
    const held = h.analyzer.holdVideo('b.mp4')
    await h.jobs.analyzeAgain(project.id, 'More crowd.')
    await eventually(() => {
      expect(stages(project.id)[0]).toBe('done')
      expect(held.waiting).toBe(1)
    })
    h.jobs.cancelAnalysis(project.id)
    await h.jobs.whenIdle()
    const result = h.store.get(project.id)

    expect(stages(project.id)).toEqual(['done', 'cancelled'])
    expect(result.brief.prompt).toBe(`${project.brief.prompt}\nMore crowd.`)
    const ofVideo = (p: Project, videoId: string): string[] =>
      p.moments.filter((m) => m.videoId === videoId).map((m) => m.title)
    expect(ofVideo(result, videoIds[0])).toEqual(['New'])
    expect(ofVideo(result, videoIds[1])).toEqual(ofVideo(before, videoIds[1]))
    // like every cancelled run with a result: the reel is put together from what is there, no toast
    expect(result.reelEdited).toBe(false)
    expect(result.moments.find((m) => m.title === 'New')?.selected).toBe(true)
    expect(h.toasts).toEqual([])
  })

  it('failed: the wish stays, the earlier clips and the reel stay as they were', async () => {
    const { project } = await h.preparedProject(['a.mp4', 'b.mp4'])
    const analysed = await analyse(project.id)
    edit(project.id, { type: 'toggleMoment', momentId: analysed.moments[0].id, selected: false })
    const before = h.store.get(project.id)
    h.toasts.length = 0
    for (const name of ['a.mp4', 'b.mp4']) {
      h.analyzer.errors.set(name, new AnalyzerError('network', 'No connection.'))
    }

    const result = await again(project.id, 'More crowd.')

    expect(stages(project.id)).toEqual(['error', 'error'])
    expect(result.brief.prompt).toBe(`${project.brief.prompt}\nMore crowd.`)
    expect(result.moments).toEqual(before.moments)
    // nothing was replaced: the reel edited by hand is still protected, as after a failed re-analysis
    expect(before.reelEdited).toBe(true)
    expect(result.reelEdited).toBe(true)
    expect(h.toasts.map((toast) => toast.level)).toEqual(['error'])
  })

  it('cancelled before any result: clips and reel stay, an edited reel stays protected, an automatic one automatic', async () => {
    const { project } = await h.preparedProject(['a.mp4', 'b.mp4'])
    const analysed = await analyse(project.id)
    for (const edited of [false, true]) {
      if (edited) {
        edit(project.id, {
          type: 'toggleMoment',
          momentId: analysed.moments[0].id,
          selected: false
        })
      }
      const before = h.store.get(project.id)
      expect(before.reelEdited).toBe(edited)
      const gate = h.analyzer.hold()
      await h.jobs.analyzeAgain(project.id, 'More crowd.')
      await gate.reached
      // while it runs, the reel counts as automatic: the run puts it together anew
      expect(h.store.get(project.id).reelEdited).toBe(false)
      h.jobs.cancelAnalysis(project.id)
      await h.jobs.whenIdle()
      const result = h.store.get(project.id)
      expect(stages(project.id)).toEqual(['cancelled', 'cancelled'])
      expect(result.moments).toEqual(before.moments)
      expect(result.reelEdited).toBe(edited)
    }
  })

  it('goes on after a failed or cancelled run: the next run of the same brief shows the remaining videos their earlier clips', async () => {
    const { project } = await h.preparedProject(['a.mp4', 'b.mp4', 'c.mp4'])
    await analyse(project.id)
    const all = gemini([true, true, true])
    const requests = (): unknown[] =>
      h.analyzer.calls.map((call) => [call.video.fileName, call.earlierClips])

    // b fails, c is cancelled: "Try again" for b, then "Retry failed videos"
    h.analyzer.errors.set('b.mp4', new AnalyzerError('network', 'No connection.'))
    const held = h.analyzer.holdVideo('c.mp4')
    await h.jobs.analyzeAgain(project.id, 'More crowd.')
    await eventually(() => {
      expect(stages(project.id).slice(0, 2)).toEqual(['done', 'error'])
      expect(held.waiting).toBe(1)
    })
    h.jobs.cancelAnalysis(project.id)
    await h.jobs.whenIdle()
    expect(stages(project.id)).toEqual(['done', 'error', 'cancelled'])
    const [, b] = h.store.get(project.id).videos.map((video) => video.id)
    h.analyzer.errors.delete('b.mp4')
    held.release()
    h.analyzer.calls.length = 0

    await analyse(project.id, { videoIds: [b] })
    expect(requests()).toEqual([['b.mp4', all]])
    await analyse(project.id)
    expect(requests()).toEqual([
      ['b.mp4', all],
      ['c.mp4', all]
    ])
    for (const call of h.analyzer.calls)
      expect(call.brief.prompt.endsWith('\nMore crowd.')).toBe(true)
    // every video got through: a later run is a normal analysis again
    h.analyzer.calls.length = 0
    await analyse(project.id, { force: true })
    // a.mp4 and b.mp4 run side by side: which one asks first is open
    expect(h.analyzer.calls.map((call) => call.video.fileName).sort()).toEqual([
      'a.mp4',
      'b.mp4',
      'c.mp4'
    ])
    for (const call of h.analyzer.calls) expect(call.earlierClips).toBeUndefined()
  })

  it('does not go on with another brief: a changed prompt makes the next run a normal analysis', async () => {
    const { project } = await h.preparedProject(['a.mp4', 'b.mp4'])
    await analyse(project.id)
    h.analyzer.errors.set('b.mp4', new AnalyzerError('network', 'No connection.'))
    await again(project.id, 'More crowd.')
    h.analyzer.errors.delete('b.mp4')
    h.analyzer.calls.length = 0

    edit(project.id, { type: 'setBrief', patch: { prompt: 'Only the drops.' } })
    await analyse(project.id)
    expect(h.analyzer.calls.map((call) => call.video.fileName).sort()).toEqual(['a.mp4', 'b.mp4'])
    for (const call of h.analyzer.calls) expect(call.earlierClips).toBeUndefined()
    // also not when the old brief comes back
    edit(project.id, {
      type: 'setBrief',
      patch: { prompt: `${project.brief.prompt}\nMore crowd.` }
    })
    h.analyzer.calls.length = 0
    await analyse(project.id)
    expect(h.analyzer.calls).toHaveLength(2)
    for (const call of h.analyzer.calls) expect(call.earlierClips).toBeUndefined()
  })
})
