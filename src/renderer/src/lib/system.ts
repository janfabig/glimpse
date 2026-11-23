// Texts about the local toolchain (ffmpeg).

import type { FfmpegStatus } from '@shared/types'

/**
 * The command main names when a development build has no working ffmpeg (media/errors.ts). The
 * packaged app carries its own ffmpeg and main names no command there: the app is damaged.
 */
const FETCH_COMMAND = 'node scripts/fetch-ffmpeg.mjs'

export interface CommandHint {
  before: string
  /** shown as code; null when no command helps (the packaged app is damaged) */
  command: string | null
  after: string
}

/**
 * The hint for a missing or broken ffmpeg (Settings → System): main's message, with its command
 * shown as code. After fetching, main looks for ffmpeg anew whenever it is asked while none works,
 * so no restart is needed: the home screen's “Check again” asks.
 */
export function ffmpegHint(error: string | undefined): CommandHint {
  const text = error?.trim() || 'ffmpeg was not found.'
  const at = text.indexOf(FETCH_COMMAND)
  if (at < 0) return { before: text, command: null, after: '' }
  return {
    before: text.slice(0, at),
    command: FETCH_COMMAND,
    after: '. Then click “Check again” on the home screen.'
  }
}

export interface FfmpegBlocker {
  /** ffmpeg and ffprobe were found but do not start */
  broken: boolean
  title: string
  text: string
  /** development only: the command that fetches ffmpeg, shown as a code block below `text` */
  command: string | null
  hint: string
}

/**
 * The home screen's blocker, from main's status. In the packaged app ffmpeg is part of the app, so
 * it can only be missing when the app is damaged: nothing to install, the app is replaced. A
 * development build gets the command that fetches ffmpeg.
 */
export function ffmpegBlocker(
  status: Pick<FfmpegStatus, 'ffmpegPath' | 'ffprobePath' | 'error'>
): FfmpegBlocker {
  const broken = !!status.ffmpegPath && !!status.ffprobePath
  const { before, command } = ffmpegHint(status.error)
  if (!command) {
    return {
      broken,
      title: 'Glimpse is damaged',
      text:
        'The ffmpeg inside the app is missing or does not start, and Glimpse needs it to read and ' +
        'cut your videos. Unzip Glimpse again and replace the app in your Applications folder ' +
        'with the fresh copy.',
      command: null,
      hint: 'Your projects and settings are kept.'
    }
  }
  return {
    broken,
    title: broken ? 'ffmpeg does not start' : 'ffmpeg is missing',
    // main's sentence ends with "run:", the command follows as a code block
    text: before.trim(),
    command,
    hint:
      'This only happens in a development build. You can also install ffmpeg with Homebrew ' +
      '(brew install ffmpeg). Then click “Check again”.'
  }
}
