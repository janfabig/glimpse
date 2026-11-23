import { describe, expect, it } from 'vitest'
import type { Moment, VideoInfo } from '@shared/types'
import { JOB_MESSAGES } from '../../../main/core/jobs/messages'
import { MESSAGES as MEDIA_MESSAGES } from '../../../main/media/errors'
import { isMissingOriginal, videoRemovalMessage } from './project'

const video = { id: 'v1', fileName: 'VID_1.mp4' } as VideoInfo
const moment = (selected: boolean, videoId = 'v1'): Moment => ({ videoId, selected }) as Moment

describe('videoRemovalMessage', () => {
  it('agrees in number', () => {
    expect(videoRemovalMessage({ moments: [moment(true)] }, video)).toBe(
      '“VID_1.mp4” has 1 clip in your highlight video. It disappears from the project together ' +
        'with the video. The original file is kept.'
    )
    expect(videoRemovalMessage({ moments: [moment(false)] }, video)).toBe(
      '“VID_1.mp4” has 1 more suggestion. It disappears from the project together with the ' +
        'video. The original file is kept.'
    )
    expect(
      videoRemovalMessage(
        { moments: [moment(true), moment(true), moment(false), moment(true, 'v2')] },
        video
      )
    ).toBe(
      '“VID_1.mp4” has 2 clips in your highlight video and 1 more suggestion. They disappear ' +
        'from the project together with the video. The original file is kept.'
    )
  })
})

describe('isMissingOriginal', () => {
  it('recognises main’s text for a moved or deleted original', () => {
    expect(isMissingOriginal(JOB_MESSAGES.missingOriginal('VID_1.mp4'))).toBe(true)
    // the media module's text when ffmpeg/ffprobe cannot find the file
    expect(isMissingOriginal(MEDIA_MESSAGES.missingFile('VID_1.mp4'))).toBe(true)
    expect(isMissingOriginal(JOB_MESSAGES.prepareFailed)).toBe(false)
    expect(isMissingOriginal(undefined)).toBe(false)
  })
})
