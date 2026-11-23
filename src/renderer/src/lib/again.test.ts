import { describe, expect, it } from 'vitest'
import { LIMITS } from '@shared/presets'
import type { AnalysisStage, AppSettings, Project } from '@shared/types'
import { againBlocker, againDialog } from './again'
import { freeQuotaWarning } from './cost'

const settings: AppSettings = {
  model: 'gemini-3.8-flash',
  hasApiKey: true,
  apiKeySource: 'keychain',
  defaultOutputDir: '/Users/demo/Movies/Glimpse',
  fakeAi: false
}

const NOW = Date.parse('2026-11-15T20:00:00Z')

/** `analysedAt`: every video has a result from then */
function projectWith(
  videoCount: number,
  stage: AnalysisStage = 'done',
  prompt = 'Drops.',
  analysedAt = '2026-11-01T20:00:00Z'
): Project {
  const videos = Array.from({ length: videoCount }, (_, i) => ({ id: `v${i}` }))
  return {
    videos,
    analyses: Object.fromEntries(videos.map((video) => [video.id, { createdAt: analysedAt }])),
    status: Object.fromEntries(
      videos.map((video) => [
        video.id,
        { prepare: { status: 'done', progress: 1 }, analysis: { stage, progress: 1 } }
      ])
    ),
    brief: { prompt, targetDurationSec: 60 }
  } as unknown as Project
}

describe('"Ask Gemini again": when it can start', () => {
  it('needs videos, a key (or the test analyzer) and no analysis that is running', () => {
    expect(againBlocker(projectWith(3), settings)).toBeNull()
    expect(againBlocker(projectWith(3), { ...settings, hasApiKey: false, fakeAi: true })).toBeNull()
    // the settings are still loading: main checks again
    expect(againBlocker(projectWith(3), null)).toBeNull()

    expect(againBlocker(projectWith(3, 'analyzing'), settings)).toBe('The analysis is running.')
    expect(againBlocker(projectWith(3, 'queued'), settings)).toBe('The analysis is running.')
    expect(againBlocker(projectWith(0), settings)).toBe('Add videos first.')
    expect(againBlocker(projectWith(3), { ...settings, hasApiKey: false })).toBe(
      'Connect Gemini first in Settings.'
    )
  })
})

describe('"Ask Gemini again": the dialog', () => {
  it('says what happens: every video again, one request each, everything replaced', () => {
    const many = againDialog(projectWith(4), settings, '')
    expect(many.intro).toBe(
      'Gemini looks at all 4 videos again, one request per video. Your note is added as a new line at the end of your prompt and stays there.'
    )
    expect(many.consequence).toBe(
      'Everything Gemini has suggested so far is replaced, and your changes to those clips are lost. After that, your highlight video is put together again.'
    )
    expect(againDialog(projectWith(1), settings, '').intro).toContain(
      'Gemini looks at your video again, with one request.'
    )
  })

  it('starts only with text', () => {
    expect(againDialog(projectWith(2), settings, '')).toMatchObject({
      canStart: false,
      tooLong: null
    })
    expect(againDialog(projectWith(2), settings, ' \n ').canStart).toBe(false)
    expect(againDialog(projectWith(2), settings, 'More crowd.')).toMatchObject({
      canStart: true,
      tooLong: null
    })
  })

  it('says when the note does not fit into the prompt any more', () => {
    const project = projectWith(2, 'done', 'a'.repeat(LIMITS.promptMax - 10))
    expect(againDialog(project, settings, 'b'.repeat(9))).toMatchObject({
      canStart: true,
      tooLong: null
    })
    expect(againDialog(project, settings, 'b'.repeat(10))).toMatchObject({
      canStart: false,
      tooLong:
        'Your note no longer fits into your prompt (together at most 10,000 characters). Shorten it or your prompt.'
    })
  })

  it('warns like the Prompt step when the free quota is too small for every video', () => {
    expect(againDialog(projectWith(20), settings, 'More crowd.').quotaWarning).toBeNull()
    const warning = againDialog(projectWith(21), settings, 'More crowd.').quotaWarning
    expect(warning).toBe(freeQuotaWarning('gemini-3.8-flash', 21))
    expect(warning).toContain('about 20 analyses a day')
    // the analyses of the last 24 hours used the same daily quota: 12 + 12 requests are too many
    const today = projectWith(12, 'done', 'Drops.', '2026-11-15T18:00:00Z')
    expect(againDialog(today, settings, 'More crowd.', NOW).quotaWarning).toBe(warning)
    const yesterday = projectWith(12, 'done', 'Drops.', '2026-11-14T19:00:00Z')
    expect(againDialog(yesterday, settings, 'More crowd.', NOW).quotaWarning).toBeNull()
    expect(
      againDialog(projectWith(10, 'done', 'Drops.', '2026-11-15T18:00:00Z'), settings, 'x', NOW)
        .quotaWarning
    ).toBeNull()
    // a warning, not a stop
    expect(againDialog(projectWith(21), settings, 'More crowd.').canStart).toBe(true)
  })

  it('cannot start while the button could not', () => {
    expect(againDialog(projectWith(2, 'uploading'), settings, 'More crowd.').canStart).toBe(false)
  })
})
