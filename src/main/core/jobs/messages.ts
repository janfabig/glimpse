// User-facing texts of the background jobs.

import type { AnalysisStage } from '@shared/types'
import { LOG_HINT } from '../errors'

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export const JOB_MESSAGES = {
  noApiKey: 'Connect Gemini first: add your API key in Settings.',
  /** a key is stored, but the Keychain no longer hands it out */
  apiKeyUnreadable: 'Your saved API key can no longer be read. Paste it again in Settings.',
  /** only when media gives no reason of its own (it names what to do: media/errors.ts) */
  noFfmpeg: 'ffmpeg was not found.',
  videoNotFound: 'The video was not found.',

  // import & preparation
  invalidPath: 'Invalid file path.',
  notAVideo: 'Not a supported video file.',
  alreadyInProject: 'Already in the project.',
  fileMissing: 'The file was not found.',
  folderWithoutVideos: 'This folder has no supported videos.',
  unreadable: 'The file could not be read.',
  stillCopying: 'The file is still being copied. Add it once it is finished.',
  prepareFailed: 'The preview could not be created.',
  missingOriginal: (fileName: string): string =>
    `The original file “${fileName}” was not found. Was it moved? Then add it again from its new place. Your clips are kept.`,
  relinked: (names: readonly string[]): string =>
    names.length === 1
      ? `“${names[0]}” is linked again. Your clips are kept.`
      : `${names.length} videos are linked again. Your clips are kept.`,

  // analysis
  noVideos: 'Add videos first.',
  analysisBusy: 'The analysis is already running.',
  /** "Ask Gemini again": the prompt with the new line would exceed its longest length */
  wishTooLong: 'Your note no longer fits into your prompt. Shorten it or your prompt.',
  /** the preparation failed: its reason (e.g. the original is gone) tells what to do */
  previewMissing: (reason?: string): string =>
    reason
      ? `The preview for this video is missing: ${reason}`
      : 'The preview for this video is missing. Create it again, then start the analysis.',
  analysisFailed: 'An unexpected error occurred during the analysis.',
  cancelled: 'Cancelled',
  momentsFound: (n: number): string =>
    n === 0 ? 'No matching moments found' : `${plural(n, 'moment', 'moments')} found`,
  analysisDone: (moments: number, videos: number): string =>
    `Analysis done: ${plural(moments, 'moment', 'moments')} from ${plural(videos, 'video', 'videos')}`,
  /** the user's hand-edited reel stays; the new moments wait under "More suggestions" */
  analysisDoneReelKept: (moments: number): string =>
    moments === 0
      ? 'Analysis done: no new suggestions. Your selection stays.'
      : `Analysis done: ${plural(moments, 'new suggestion', 'new suggestions')}. Your selection stays. ` +
        `You can find ${moments === 1 ? 'the new moment' : 'the new moments'} under “More suggestions”.`,
  /** every failed video has the same reason */
  analysisPartlyFailed: (failed: number, reason: string): string =>
    `${plural(failed, 'video', 'videos')} could not be analysed: ${reason}`,
  /** the failed videos have different reasons, each one is shown at its video */
  analysisFailedMixed: (failed: number): string =>
    `${plural(failed, 'video', 'videos')} could not be analysed. The reason is shown at each video.`,
  retryHint: 'You can try again.',
  analysisAllFailed: (reason: string): string => `The analysis failed: ${reason}`,

  // export
  exportBusy: 'The export is already running.',
  exportMemoryBusy:
    'An export is already running in another project. This Mac does not have enough memory for a second one right now. Start it once the other one is finished.',
  exportFrameTooBig:
    'This Mac does not have enough memory for this format: the picture would be too big. Choose another format when you export.',
  nothingSelected: 'Select at least one clip for your highlight video.',
  clipWithoutVideo: 'A selected clip belongs to a video that is no longer in the project.',
  clipTooShort: (title: string): string => `The clip “${title}” is too short.`,
  changedOriginal: (fileName: string): string =>
    `The original file “${fileName}” is no longer the same as when you added it. If the original is somewhere else now, add it again from there. Otherwise remove the video and add the file again.`,
  outputDirFailed: (dir: string): string => `The export folder “${dir}” cannot be created.`,
  exportPrepareFailed: `The export could not be prepared. ${LOG_HINT}`,
  exportPreparing: 'Preparing the export…',
  exportRendering: (clip: number, count: number): string => `Rendering clip ${clip} of ${count}…`,
  exportJoining: 'Joining the clips…',
  exportFinishing: 'Finishing up…',
  exportDone: 'Done!',
  exportSaved: 'Done! Your highlight video is saved.',
  exportCancelled: 'Export cancelled.',
  exportFailed: 'An error occurred during the export.',
  exportFailedToast: (reason: string): string => `The export failed: ${reason}`
} as const

export const STAGE_MESSAGES: Partial<Record<AnalysisStage, string>> = {
  queued: 'Queued',
  'waiting-proxy': 'Waiting for the preview…',
  uploading: 'Uploading…',
  processing: 'Gemini is processing the video…',
  analyzing: 'Gemini is looking for the best moments…'
}
