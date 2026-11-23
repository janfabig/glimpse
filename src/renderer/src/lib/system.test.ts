import { describe, expect, it } from 'vitest'
import { ffmpegBlocker, ffmpegHint, type CommandHint } from './system'

const text = (hint: CommandHint): string => `${hint.before}${hint.command ?? ''}${hint.after}`

// main's texts (media/errors.ts; mock.test.ts keeps the mock's copies equal to them)
const missing = 'ffmpeg was not found. In the project folder, run: node scripts/fetch-ffmpeg.mjs'
const broken =
  'ffmpeg was found but does not start. In the project folder, run: node scripts/fetch-ffmpeg.mjs'
const damaged =
  'Glimpse is damaged: the ffmpeg inside the app is missing or does not start. ' +
  'Replace the app with a fresh copy of Glimpse.'

describe('ffmpegHint', () => {
  it('development: shows the command of main’s message as code, once', () => {
    const hint = ffmpegHint(missing)
    expect(hint.command).toBe('node scripts/fetch-ffmpeg.mjs')
    expect(text(hint)).toBe(
      'ffmpeg was not found. In the project folder, run: node scripts/fetch-ffmpeg.mjs. ' +
        'Then click “Check again” on the home screen.'
    )
    expect(text(hint).match(/fetch-ffmpeg/g)).toHaveLength(1)
    expect(ffmpegHint(broken).command).toBe('node scripts/fetch-ffmpeg.mjs')
  })

  it('the packaged app: main’s message as it is, no command and nothing to install', () => {
    expect(ffmpegHint(damaged)).toEqual({ before: damaged, command: null, after: '' })
    expect(ffmpegHint(undefined)).toEqual({
      before: 'ffmpeg was not found.',
      command: null,
      after: ''
    })
    expect(text(ffmpegHint(damaged))).not.toMatch(/brew|Terminal|node /)
  })
})

describe('ffmpegBlocker', () => {
  it('development: asks to fetch a missing ffmpeg', () => {
    const blocker = ffmpegBlocker({ ffmpegPath: null, ffprobePath: null, error: missing })
    expect(blocker).toMatchObject({
      broken: false,
      title: 'ffmpeg is missing',
      text: 'ffmpeg was not found. In the project folder, run:',
      command: 'node scripts/fetch-ffmpeg.mjs'
    })
    // the developer's other way stays named
    expect(blocker.hint).toMatch(/brew install ffmpeg/)
    // ffprobe alone is missing: still missing
    expect(
      ffmpegBlocker({ ffmpegPath: '/x/ffmpeg', ffprobePath: null, error: missing }).broken
    ).toBe(false)
  })

  it('development: names main’s reason when ffmpeg does not start', () => {
    const blocker = ffmpegBlocker({
      ffmpegPath: '/x/ffmpeg',
      ffprobePath: '/x/ffprobe',
      error: broken
    })
    expect(blocker).toMatchObject({
      broken: true,
      title: 'ffmpeg does not start',
      text: 'ffmpeg was found but does not start. In the project folder, run:',
      command: 'node scripts/fetch-ffmpeg.mjs'
    })
  })

  it('the packaged app: the app is damaged, with no command and no Homebrew', () => {
    const resources = '/Applications/Glimpse.app/Contents/Resources/ffmpeg'
    for (const status of [
      { ffmpegPath: null, ffprobePath: null, error: damaged },
      { ffmpegPath: `${resources}/ffmpeg`, ffprobePath: `${resources}/ffprobe`, error: damaged }
    ]) {
      const blocker = ffmpegBlocker(status)
      expect(blocker).toMatchObject({ title: 'Glimpse is damaged', command: null })
      expect(blocker.text).toMatch(/Unzip Glimpse again and replace the app/)
      expect(blocker.hint).toBe('Your projects and settings are kept.')
      expect(`${blocker.text} ${blocker.hint}`).not.toMatch(/brew|Terminal|fetch-ffmpeg/i)
    }
  })
})
