import { encodeIpcError, parseIpcError } from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import { AnalyzerError, MediaError } from '../contracts'
import { MESSAGES as MEDIA_MESSAGES } from '../media/errors'
import {
  CoreError,
  DISK_FULL_MESSAGE,
  folderFullMessage,
  INTERNAL_ERROR_MESSAGE,
  isCancellation,
  isDiskFull,
  toIpcPayload,
  userMessage
} from './errors'

describe('CoreError', () => {
  it('carries an encoded payload the renderer can parse', () => {
    const err = new CoreError('busy', 'The analysis is already running.')
    expect(parseIpcError(err)).toEqual({
      code: 'busy',
      message: 'The analysis is already running.'
    })
    // Electron prefixes the message when it crosses the IPC boundary
    expect(
      parseIpcError(new Error(`Error invoking remote method 'x': Error: ${err.message}`)).code
    ).toBe('busy')
  })
})

describe('toIpcPayload', () => {
  it('passes the messages of module errors through and maps their codes', () => {
    expect(toIpcPayload(new MediaError('no-ffmpeg', 'ffmpeg is missing.'))).toEqual({
      payload: { code: 'no-ffmpeg', message: 'ffmpeg is missing.' },
      expected: true
    })
    expect(toIpcPayload(new MediaError('ffmpeg', 'Broken.')).payload.code).toBe('internal')
    expect(toIpcPayload(new AnalyzerError('auth', 'Key rejected.')).payload).toEqual({
      code: 'no-api-key',
      message: 'Key rejected.'
    })
    expect(toIpcPayload(new AnalyzerError('quota', 'Quota used up.')).payload.code).toBe('internal')
  })

  it('recognises already encoded errors', () => {
    const err = new Error(encodeIpcError({ code: 'not-found', message: 'Weg.' }))
    expect(toIpcPayload(err)).toEqual({
      payload: { code: 'not-found', message: 'Weg.' },
      expected: true
    })
  })

  it('hides unexpected errors behind a generic message', () => {
    expect(toIpcPayload(new TypeError('x is undefined'))).toEqual({
      payload: { code: 'internal', message: INTERNAL_ERROR_MESSAGE },
      expected: false
    })
    expect(toIpcPayload('weird').expected).toBe(false)
    expect(INTERNAL_ERROR_MESSAGE).toBe(
      'Something went wrong. You can find details in Settings under System → Log file.'
    )
  })

  it('tells the user plainly that the disk is full', () => {
    const enospc = Object.assign(new Error('ENOSPC: no space left on device, mkdir /x/tmp'), {
      code: 'ENOSPC'
    })
    expect(toIpcPayload(enospc)).toEqual({
      payload: { code: 'internal', message: DISK_FULL_MESSAGE },
      expected: false
    })
    expect(DISK_FULL_MESSAGE).toBe(
      'There is not enough free space on your Mac. Free up some space and try again.'
    )
    // ffmpeg on a full disk (media module) says the same – one text, wherever the disk runs full
    expect(MEDIA_MESSAGES.diskFull).toBe(DISK_FULL_MESSAGE)
    // … except for an export folder on another drive: both name the folder the same way
    expect(MEDIA_MESSAGES.outputFolderFull('/Volumes/T7/Exporte')).toBe(
      folderFullMessage('/Volumes/T7/Exporte')
    )
  })
})

describe('isDiskFull', () => {
  it('recognises ENOSPC, also as a cause, and ffmpeg output about a full disk', () => {
    const enospc = Object.assign(new Error('write failed'), { code: 'ENOSPC' })
    expect(isDiskFull(enospc)).toBe(true)
    expect(isDiskFull(new Error('wrapped', { cause: enospc }))).toBe(true)
    expect(isDiskFull(Object.assign(new Error('quota'), { code: 'EDQUOT' }))).toBe(true)
    expect(
      isDiskFull(
        new MediaError(
          'ffmpeg',
          'Clip 1 of 2 could not be rendered.',
          'av_interleaved_write_frame(): No space left on device'
        )
      )
    ).toBe(true)
    // strerror(EDQUOT): "Disc quota exceeded" on macOS, "Disk quota exceeded" elsewhere
    for (const quota of ['Disc quota exceeded', 'Disk quota exceeded']) {
      expect(
        isDiskFull(new MediaError('ffmpeg', 'Broken.', `Error writing trailer: ${quota}`))
      ).toBe(true)
    }
    expect(isDiskFull(Object.assign(new Error('gone'), { code: 'ENOENT' }))).toBe(false)
    expect(isDiskFull(new MediaError('ffmpeg', 'Broken.', 'Invalid data found'))).toBe(false)
    expect(isDiskFull(null)).toBe(false)
  })
})

describe('helpers', () => {
  it('detects cancellations of every kind', () => {
    expect(isCancellation(new MediaError('cancelled', 'Cancelled.'))).toBe(true)
    expect(isCancellation(new AnalyzerError('cancelled', 'Cancelled.'))).toBe(true)
    expect(isCancellation(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true)
    expect(isCancellation(new Error('x'), AbortSignal.abort())).toBe(true)
    expect(isCancellation(new MediaError('ffmpeg', 'x'))).toBe(false)
  })

  it('uses messages of our own errors, else the fallback', () => {
    expect(userMessage(new MediaError('ffmpeg', 'Clip 2 broken.'), 'Fallback')).toBe(
      'Clip 2 broken.'
    )
    expect(userMessage(new CoreError('invalid', 'Invalid.'), 'Fallback')).toBe('Invalid.')
    expect(userMessage(new Error('ENOENT: /secret/path'), 'Fallback')).toBe('Fallback')
    expect(
      userMessage(Object.assign(new Error('ENOSPC: /secret/path'), { code: 'ENOSPC' }), 'Fallback')
    ).toBe(DISK_FULL_MESSAGE)
    expect(
      userMessage(
        new MediaError('ffmpeg', 'The preview could not be created.', 'No space left on device'),
        'Fallback'
      )
    ).toBe(DISK_FULL_MESSAGE)
    // media names a full export folder on another drive: that text stays
    const folderFull = new MediaError(
      'ffmpeg',
      MEDIA_MESSAGES.outputFolderFull('/Volumes/T7/Exporte'),
      'No space left on device'
    )
    expect(userMessage(folderFull, 'Fallback')).toBe(folderFullMessage('/Volumes/T7/Exporte'))
  })
})
