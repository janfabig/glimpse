import { describe, expect, it } from 'vitest'
import type { Project, VideoStatus } from '@shared/types'
import { analysisPlan, formatTargetLabel, targetOptions } from './brief'

describe('target length options', () => {
  it('labels every length the same way', () => {
    expect([30, 45, 60, 90, 150, 180, null].map(formatTargetLabel)).toEqual([
      '30 s',
      '45 s',
      '1 min',
      '1:30 min',
      '2:30 min',
      '3 min',
      'No limit'
    ])
  })

  it('puts a length from elsewhere into its sorted place, "No limit" stays last', () => {
    expect(targetOptions(60)).toEqual([30, 60, 90, 180, null])
    expect(targetOptions(null)).toEqual([30, 60, 90, 180, null])
    expect(targetOptions(45)).toEqual([30, 45, 60, 90, 180, null])
    expect(targetOptions(600)).toEqual([30, 60, 90, 180, 600, null])
  })
})

describe('analysisPlan', () => {
  const status = (prepare: VideoStatus['prepare']['status'], stage = 'idle'): VideoStatus =>
    ({ prepare: { status: prepare, progress: 0 }, analysis: { stage, progress: 0 } }) as VideoStatus
  const project = {
    videos: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })),
    status: {
      a: status('done', 'done'),
      b: status('done', 'done'),
      c: status('done'),
      d: status('error'),
      e: status('running')
    },
    analyses: { a: { briefHash: 'now' }, b: { briefHash: 'old' } }
  } as unknown as Project

  it('counts the videos Gemini will see and leaves out failed previews', () => {
    expect(analysisPlan(project, 'now')).toEqual({
      toAnalyse: 3,
      stale: 1,
      fresh: 1,
      withoutPreview: 1
    })
    // while the hash is computed every video counts, still without the failed preview
    expect(analysisPlan(project, null)).toEqual({
      toAnalyse: 4,
      stale: 0,
      fresh: 0,
      withoutPreview: 1
    })
  })

  it('calls a result outdated only when the prompt or the model changed, not after a failed re-run', () => {
    const failedAgain = {
      ...project,
      videos: [{ id: 'a' }, { id: 'b' }],
      status: { a: status('done', 'error'), b: status('done', 'cancelled') },
      analyses: { a: { briefHash: 'now' }, b: { briefHash: 'old' } }
    } as unknown as Project
    expect(analysisPlan(failedAgain, 'now')).toEqual({
      toAnalyse: 2,
      stale: 1,
      fresh: 0,
      withoutPreview: 0
    })
  })

  it('counts a video whose filmstrip failed – its proxy is there, main analyses it', () => {
    const spriteFailed = {
      ...project,
      videos: [{ id: 'a', proxyPath: '/data/a/proxy.mp4' }],
      status: {
        a: {
          prepare: {
            status: 'error',
            progress: 0,
            error: 'The filmstrip could not be created.'
          },
          analysis: { stage: 'idle', progress: 0 }
        }
      },
      analyses: {}
    } as unknown as Project
    expect(analysisPlan(spriteFailed, 'now')).toEqual({
      toAnalyse: 1,
      stale: 0,
      fresh: 0,
      withoutPreview: 0
    })
  })
})
