import { describe, expect, it } from 'vitest'
import type { AnalysisRemedy, Moment, Project, VideoStatus } from '@shared/types'
import { JOB_MESSAGES } from '../../../main/core/jobs/messages'
import {
  analysisOverview,
  analysisTargets,
  describePreviewFailures,
  describeReanalysis,
  estimateRemainingSec,
  hasOwnTrim,
  failureAction,
  failureOverview,
  failureText,
  prepareOverview,
  previewFailed,
  PREVIEW_READY_NOW,
  reanalysisImpact,
  reelKeptAfterRun,
  remedyOf,
  stageFraction,
  type ReanalysisImpact
} from './analysis'
import { initialStep, stepAvailability } from './steps'

function projectWith(statuses: VideoStatus['analysis'][], extra: Partial<Project> = {}): Project {
  const videos = statuses.map((_, i) => ({ id: `v${i}` }))
  return {
    videos,
    status: Object.fromEntries(
      statuses.map((analysis, i) => [
        `v${i}`,
        { prepare: { status: 'done', progress: 1 }, analysis } satisfies VideoStatus
      ])
    ),
    analyses: {},
    moments: [],
    exports: [],
    ...extra
  } as unknown as Project
}

describe('analysis progress', () => {
  it('maps stages to a share of the per-video pipeline', () => {
    expect(stageFraction('queued', 0)).toBe(0)
    expect(stageFraction('uploading', 0.5)).toBeCloseTo(0.2)
    expect(stageFraction('analyzing', 1)).toBeCloseTo(0.97)
    expect(stageFraction('done', 0)).toBe(1)
    expect(stageFraction('error', 0.5)).toBe(0)
  })

  it('summarises a run and ignores idle videos', () => {
    const project = projectWith([
      { stage: 'done', progress: 1 },
      { stage: 'uploading', progress: 0.5 },
      { stage: 'error', progress: 0 },
      { stage: 'idle', progress: 0 }
    ])
    const overview = analysisOverview(project)
    expect(overview).toMatchObject({ total: 3, done: 1, failed: 1, running: 1, active: true })
    expect(overview.fraction).toBeCloseTo((1 + 0.2 + 0) / 3)
  })

  it('estimates the remaining time from measured runs', () => {
    const project = projectWith([
      {
        stage: 'done',
        progress: 1,
        startedAt: '2026-01-01T10:00:00.000Z',
        finishedAt: '2026-01-01T10:01:40.000Z'
      },
      { stage: 'queued', progress: 0 },
      { stage: 'queued', progress: 0 }
    ])
    // two whole videos à 100 s, two in parallel
    expect(estimateRemainingSec(project)).toBeCloseTo(100)
    expect(estimateRemainingSec(projectWith([{ stage: 'done', progress: 1 }]))).toBeNull()
  })

  it('estimates with the typical 1–2 minutes per video before the first one is done', () => {
    const waiting = projectWith([
      { stage: 'queued', progress: 0 },
      { stage: 'queued', progress: 0 }
    ])
    expect(estimateRemainingSec(waiting)).toBeCloseTo(90)
  })

  it('counts the background preparation', () => {
    const project = {
      videos: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      status: {
        a: { prepare: { status: 'done', progress: 1 } },
        b: { prepare: { status: 'running', progress: 0.4 } }
      }
    } as unknown as Project
    expect(prepareOverview(project)).toEqual({
      total: 3,
      done: 1,
      running: 1,
      pending: 1,
      failed: 0,
      withoutFilmstrip: 0
    })
  })

  it('names a failed filmstrip apart from a missing preview', () => {
    expect(describePreviewFailures(1)).toBe(
      '1 video has no preview. Take a look at the marked card.'
    )
    expect(describePreviewFailures(3, 1)).toBe(
      '2 videos have no preview and 1 video has no filmstrip. Take a look at the marked cards.'
    )
    expect(describePreviewFailures(2, 2)).toBe(
      '2 videos have no filmstrip. Take a look at the marked cards.'
    )
  })
})

describe('steps', () => {
  it('unlocks steps as the project progresses', () => {
    const fresh = projectWith([])
    expect(stepAvailability(fresh)).toEqual({
      videos: true,
      brief: false,
      analysis: false,
      review: false,
      export: false
    })
    const running = projectWith([{ stage: 'analyzing', progress: 0.3 }])
    expect(stepAvailability(running)).toMatchObject({ brief: true, analysis: true, review: false })
    expect(initialStep(running)).toBe('analysis')
  })

  it('opens finished projects in the review', () => {
    const project = projectWith([{ stage: 'done', progress: 1 }], {
      moments: [{ id: 'm', selected: true } as Project['moments'][number]]
    })
    expect(initialStep(project)).toBe('review')
    expect(stepAvailability(project).export).toBe(true)
    expect(initialStep(projectWith([{ stage: 'idle', progress: 0 }]))).toBe('videos')
  })
})

describe('re-analysis', () => {
  const moment = (id: string, videoId: string, extra: Partial<Moment> = {}): Moment => ({
    id,
    videoId,
    start: 10,
    end: 14,
    title: id,
    reason: '',
    score: 7,
    selected: false,
    aiStart: 10,
    aiEnd: 14,
    ...extra
  })

  function analysed(moments: Moment[], reelEdited = true): Project {
    return projectWith(
      [
        { stage: 'done', progress: 1 },
        { stage: 'error', progress: 0 },
        { stage: 'idle', progress: 0 }
      ],
      {
        moments,
        reelEdited,
        analyses: {
          v0: { briefHash: 'current' },
          v1: { briefHash: 'current' }
        } as unknown as Project['analyses']
      }
    )
  }

  it('targets the same videos as main', () => {
    const project = analysed([])
    // v1 failed since its last result, v2 was never analysed
    expect(analysisTargets(project, 'current')).toEqual(['v1', 'v2'])
    expect(analysisTargets(project, 'other')).toEqual(['v0', 'v1', 'v2'])
    expect(analysisTargets(project, 'current', { force: true })).toEqual(['v0', 'v1', 'v2'])
    expect(analysisTargets(project, 'current', { videoIds: ['v2', 'nope'] })).toEqual(['v2'])
    expect(analysisTargets(project, null)).toEqual(['v1', 'v2'])
  })

  it('treats a cancelled or interrupted attempt like a failed one', () => {
    const project = analysed([])
    project.status.v0.analysis = { stage: 'cancelled', progress: 0, message: 'Interrupted' }
    expect(analysisTargets(project, 'current')).toEqual(['v0', 'v1', 'v2'])
    expect(analysisTargets(project, null)).toEqual(['v0', 'v1', 'v2'])
  })

  it('never asks for an automatic reel – unless own trims would be replaced', () => {
    const reel = [moment('a', 'v0', { selected: true }), moment('b', 'v1', { selected: true })]
    // main rebuilds an automatic reel after the run
    expect(reanalysisImpact(analysed(reel, false), ['v0', 'v1'])).toBeNull()
    // a trim by the automatic selection is no own trim
    const autoTrimmed = moment('t', 'v0', {
      selected: true,
      start: 11,
      autoTrimmedFrom: { start: 10, end: 14 }
    })
    expect(reanalysisImpact(analysed([autoTrimmed], false), ['v0'])).toBeNull()
    // own trims survive "Auto-select" – replacing them asks
    const trimmed = moment('c', 'v0', { end: 13 })
    const impact = reanalysisImpact(analysed([...reel, trimmed], false), ['v0'])
    expect(impact).toEqual({ videos: 1, selected: 0, trimmed: 1, kept: 2, rebuilt: true })
    expect(describeReanalysis(impact!)).toBe(
      'Gemini looks at the video again and replaces its earlier suggestions. Your trim on 1 clip ' +
        'is lost. After that, your highlight video is put together again automatically.'
    )
  })

  it('asks for an edited reel only when its clips or trims of the analysed videos would go', () => {
    const reel = [
      moment('a', 'v0', { selected: true }),
      // own trim of a suggestion
      moment('b', 'v0', { start: 11 }),
      // own trim of a reel clip of another video
      moment('c', 'v1', { selected: true, end: 15 }),
      moment('d', 'v2', { selected: true })
    ]
    expect(reanalysisImpact(analysed(reel), [])).toBeNull()
    const impact = reanalysisImpact(analysed(reel), ['v0'])
    expect(impact).toEqual({ videos: 1, selected: 1, trimmed: 1, kept: 2, rebuilt: false })
    expect(describeReanalysis(impact!)).toBe(
      'Gemini looks at the video again and replaces its earlier suggestions. 1 clip disappears ' +
        'from your highlight video, and your trim on 1 clip is lost. The remaining 2 clips stay ' +
        'in your order, and you will find the new moments under “More suggestions” afterwards.'
    )
    expect(reanalysisImpact(analysed(reel), ['v0', 'v1'])).toEqual({
      videos: 2,
      selected: 2,
      trimmed: 2,
      kept: 1,
      rebuilt: false
    })
  })

  it('treats an edited reel that would end up empty as rebuilt, like main', () => {
    const reel = [moment('a', 'v0', { selected: true }), moment('b', 'v1', { selected: true })]
    const impact = reanalysisImpact(analysed(reel), ['v0', 'v1'])
    expect(impact).toEqual({ videos: 2, selected: 2, trimmed: 0, kept: 0, rebuilt: true })
    expect(describeReanalysis(impact!)).toBe(
      'Gemini looks at 2 videos again and replaces their earlier suggestions. 2 clips disappear ' +
        'from your highlight video. After that, your highlight video is put together again ' +
        'automatically.'
    )
    // one clip of another video stays: the edited reel is kept
    expect(reanalysisImpact(analysed(reel), ['v0'])).toMatchObject({ kept: 1, rebuilt: false })
  })

  it('knows during a run whether the edited reel stays', () => {
    const running = (moments: Moment[], reelEdited = true): Project =>
      projectWith(
        [
          { stage: 'analyzing', progress: 0.5 },
          { stage: 'done', progress: 1 }
        ],
        { moments, reelEdited }
      )
    // a clip of the video that is not analysed survives
    expect(reelKeptAfterRun(running([moment('b', 'v1', { selected: true })]))).toBe(true)
    // only clips of the analysed video: the reel is put together again
    expect(reelKeptAfterRun(running([moment('a', 'v0', { selected: true })]))).toBe(false)
    // an automatic reel is always rebuilt
    expect(reelKeptAfterRun(running([moment('b', 'v1', { selected: true })], false))).toBe(false)
  })

  it('says concretely what is lost and what stays', () => {
    const text = (impact: Partial<ReanalysisImpact>): string =>
      describeReanalysis({ videos: 1, selected: 0, trimmed: 0, kept: 0, rebuilt: false, ...impact })
    expect(text({ videos: 3, selected: 4, kept: 1 })).toBe(
      'Gemini looks at 3 videos again and replaces their earlier suggestions. 4 clips disappear ' +
        'from your highlight video. The remaining clip stays in your highlight video, and you ' +
        'will find the new moments under “More suggestions” afterwards.'
    )
    expect(text({ videos: 2, trimmed: 2, kept: 5 })).toBe(
      'Gemini looks at 2 videos again and replaces their earlier suggestions. Your trims on 2 ' +
        'clips are lost. Your highlight video stays as it is. You will find the new moments ' +
        'under “More suggestions” afterwards.'
    )
    // the reel would be empty afterwards: main puts it together automatically again
    expect(text({ videos: 5, selected: 11, trimmed: 2, rebuilt: true })).toBe(
      'Gemini looks at 5 videos again and replaces their earlier suggestions. 11 clips ' +
        'disappear from your highlight video, and your trims on 2 clips are lost. After that, ' +
        'your highlight video is put together again automatically.'
    )
  })

  it('counts only the user’s own trims', () => {
    expect(hasOwnTrim(moment('a', 'v0'))).toBe(false)
    expect(hasOwnTrim(moment('a', 'v0', { end: 14.5 }))).toBe(true)
    // a clip without Gemini's times was added by hand in an older version: all of it is the user's
    const own = moment('o', 'v0', { aiStart: undefined, aiEnd: undefined })
    expect(hasOwnTrim(own)).toBe(true)
    expect(reanalysisImpact(analysed([own], false), ['v0'])).toMatchObject({ trimmed: 1 })
    expect(reanalysisImpact(analysed([own], false), ['v1'])).toBeNull()
    // trimmed only by the automatic selection
    const auto = { start: 11, autoTrimmedFrom: { start: 10, end: 14 } }
    expect(hasOwnTrim(moment('a', 'v0', auto))).toBe(false)
    // the user's trim from before an automatic one still counts
    const both = { start: 11.5, autoTrimmedFrom: { start: 11, end: 14 } }
    expect(hasOwnTrim(moment('a', 'v0', both))).toBe(true)
  })
})

describe('failed analyses', () => {
  const QUOTA = 'Your daily Gemini quota is used up.'
  const failed = (remedy: AnalysisRemedy | undefined, error = QUOTA): VideoStatus['analysis'] => ({
    stage: 'error',
    progress: 0,
    error,
    remedy
  })

  it('follows main’s remedy; older errors and cancelled videos can be tried again', () => {
    expect(remedyOf(failed('settings'))).toBe('settings')
    expect(remedyOf(failed(undefined))).toBe('retry')
    expect(remedyOf({ stage: 'cancelled', progress: 0 })).toBe('retry')
    expect(remedyOf({ stage: 'done', progress: 1 })).toBeNull()
    expect(remedyOf(undefined)).toBeNull()
  })

  it('offers the action that can help', () => {
    const project = projectWith([
      failed('retry'),
      failed('settings'),
      failed('none'),
      failed('prepare'),
      failed('prepare'),
      { stage: 'done', progress: 1 }
    ])
    project.status.v3.prepare = { status: 'error', progress: 0, error: 'ffmpeg crashed.' }
    project.status.v4.prepare = {
      status: 'error',
      progress: 0,
      error: JOB_MESSAGES.missingOriginal('d.mp4')
    }
    expect(project.videos.map((v) => failureAction(project, v.id))).toEqual([
      'retry',
      'settings',
      null,
      'rebuild-preview',
      'go-videos',
      null
    ])
  })

  it('names the shared reason and retries only what can work', () => {
    const quota = projectWith([
      { stage: 'done', progress: 1 },
      failed('settings'),
      failed('settings')
    ])
    // the settings' videos can be tried again once the settings are fixed (another model …)
    expect(failureOverview(quota)).toEqual({
      failedIds: ['v1', 'v2'],
      retryIds: [],
      settingsIds: ['v1', 'v2'],
      sharedReason: QUOTA,
      remedies: ['settings']
    })
    const mixed = projectWith([failed('retry', 'No connection.'), failed('settings')])
    expect(failureOverview(mixed)).toMatchObject({
      retryIds: ['v0'],
      settingsIds: ['v1'],
      sharedReason: null,
      remedies: ['retry', 'settings']
    })
  })

  it('offers a plain retry once a missing preview exists after all', () => {
    const missing = `The preview of this video is missing: The original file “d-4.mp4” was not found.`
    const project = projectWith([failed('prepare', missing), failed('prepare', missing)])
    // v0: the original is back and its preview was made in the Videos step
    project.status.v0.prepare = { status: 'done', progress: 1 }
    project.status.v1.prepare = { status: 'error', progress: 0, error: 'ffmpeg crashed.' }
    expect(project.videos.map((v) => failureAction(project, v.id))).toEqual([
      'retry',
      'rebuild-preview'
    ])
    // the stale "is missing" text gives way to the current state
    expect(failureText(project, 'v0')).toBe(PREVIEW_READY_NOW)
    expect(failureText(project, 'v1')).toBe(missing)
    expect(failureOverview(project)).toMatchObject({
      retryIds: ['v0'],
      remedies: ['retry', 'prepare'],
      sharedReason: null
    })
  })

  it('counts only a missing proxy as a failed preview – not a failed filmstrip', () => {
    const project = projectWith([
      { stage: 'idle', progress: 0 },
      { stage: 'idle', progress: 0 }
    ])
    const error = 'The filmstrip could not be created.'
    project.status.v0.prepare = { status: 'error', progress: 0, error }
    project.status.v1.prepare = { status: 'error', progress: 0, error }
    // v0's proxy was made before the filmstrip failed: main analyses it
    ;(project.videos[0] as { proxyPath?: string }).proxyPath = '/data/v0/proxy.mp4'
    expect(previewFailed(project, 'v0')).toBe(false)
    expect(previewFailed(project, 'v1')).toBe(true)
  })
})
