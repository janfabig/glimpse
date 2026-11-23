// Texts of the main process that the mock API shows (core JOB_MESSAGES and IPC_MESSAGES, ai
// MESSAGES, media MESSAGES). mock.test.ts checks them against main's, so snapshots and the dev
// server show what the app says.

import type { AnalysisRemedy } from '@shared/types'
import { plural } from '../lib/format'

export const MOCK_MESSAGES = {
  noApiKey: 'Connect Gemini first: add your API key in Settings.',
  keyUnreadable: 'Your saved API key can no longer be read. Paste it again in Settings.',
  keyRejected: 'Google rejected this API key. Copy it again in full in AI Studio.',
  noKeyStored: 'No API key has been added yet.',
  noKeyForModels: 'Add your Gemini API key first.',
  keyOk: (count: number): string => `Connected: ${plural(count, 'model', 'models')} available`,

  /** a development build without ffmpeg */
  noFfmpeg: 'ffmpeg was not found. In the project folder, run: node scripts/fetch-ffmpeg.mjs',
  /** the packaged app: its own ffmpeg is missing or does not start */
  damagedApp:
    'Glimpse is damaged: the ffmpeg inside the app is missing or does not start. ' +
    'Replace the app with a fresh copy of Glimpse.',

  notAVideo: 'Not a supported video file.',
  alreadyInProject: 'Already in the project.',
  emptyFolder: 'This folder has no supported videos.',
  missingOriginal: (fileName: string): string =>
    `The original file “${fileName}” was not found. Was it moved? Then add it again from its new place. Your clips are kept.`,
  proxyFailed: 'The preview of the video could not be created.',
  spriteFailed: 'The filmstrip could not be created.',
  /** the analysis of a video whose preview failed, with the preview's reason */
  previewMissing: (reason: string): string => `The preview for this video is missing: ${reason}`,

  quotaMinute: 'Gemini is getting too many requests right now. Wait a minute and try again.',
  quotaDay:
    'Your daily Gemini quota is used up. Try again tomorrow, switch to Gemini 3.5 Flash-Lite in Settings or turn on billing in Google AI Studio.',
  auth: 'Google rejected your API key. Check it in Settings.',
  safety: 'Gemini refused to analyse this video for safety reasons.',
  processing: 'Gemini could not process the video. Try again.',

  wishTooLong: 'Your note no longer fits into your prompt. Shorten it or your prompt.',

  footageTwice:
    'This part is already in another clip in the highlight video. ' +
    'Trim one of the two clips or remove the other one.',

  momentsFound: (n: number): string =>
    n === 0 ? 'No matching moments found' : `${plural(n, 'moment', 'moments')} found`,
  analysisDone: (moments: number, videos: number): string =>
    `Analysis done: ${plural(moments, 'moment', 'moments')} from ${plural(videos, 'video', 'videos')}`,
  /** the hand-edited reel stays; the new moments wait under "More suggestions" */
  analysisDoneReelKept: (moments: number): string =>
    moments === 0
      ? 'Analysis done: no new suggestions. Your selection stays.'
      : `Analysis done: ${plural(moments, 'new suggestion', 'new suggestions')}. Your selection stays. ` +
        `You can find ${moments === 1 ? 'the new moment' : 'the new moments'} under “More suggestions”.`,
  retryHint: 'You can try again.',

  exportDone: 'Done!',
  exportSaved: 'Done! Your highlight video is saved.'
} as const

/**
 * main's toast about the failed videos at the end of a run: their shared reason, else a pointer to
 * the videos; a retry hint only when trying again can help (and the reason does not say so).
 */
export function mockFailureToast(
  failures: readonly { reason: string; remedy: AnalysisRemedy }[],
  succeeded: number
): { level: 'warning' | 'error'; message: string } {
  const level = succeeded > 0 ? 'warning' : 'error'
  const retry = failures.every((failure) => failure.remedy === 'retry')
  const reason = failures[0]?.reason ?? ''
  const subject = `${plural(failures.length, 'video', 'videos')} could not be analysed`
  if (failures.every((failure) => failure.reason === reason)) {
    const hint = retry && !/again/i.test(reason) ? ` ${MOCK_MESSAGES.retryHint}` : ''
    const message = succeeded > 0 ? `${subject}: ${reason}` : `The analysis failed: ${reason}`
    return { level, message: message + hint }
  }
  const hint = retry ? ` ${MOCK_MESSAGES.retryHint}` : ''
  return { level, message: `${subject}. The reason is shown at each video.${hint}` }
}

/** the fake analyzer's file name triggers (like main's HC_FAKE_AI): what fails and how */
export function mockAnalysisFailure(
  fileName: string
): { error: string; remedy: AnalysisRemedy; fatal: boolean } | null {
  const name = fileName.toLowerCase()
  if (name.includes('quota'))
    return { error: MOCK_MESSAGES.quotaDay, remedy: 'settings', fatal: true }
  if (name.includes('auth')) return { error: MOCK_MESSAGES.auth, remedy: 'settings', fatal: true }
  if (name.includes('safety')) return { error: MOCK_MESSAGES.safety, remedy: 'none', fatal: false }
  if (name.includes('fail'))
    return { error: MOCK_MESSAGES.processing, remedy: 'retry', fatal: false }
  return null
}
