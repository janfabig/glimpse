import { describe, expect, it } from 'vitest'
import { MediaError } from '../contracts'
import {
  environmentFailure,
  filesOfArgs,
  fsFailure,
  isEnvironmentFailure,
  MESSAGES
} from './errors'

// stderr of real ffmpeg 9 / ffprobe 9 runs (paths shortened)
const OUTPUT_DENIED = [
  '[out#0/mp4 @ 0x74c6c18180] Error opening output /Users/jan/Movies/Reels/.reel.1a2b.part.mp4: Permission denied',
  'Error opening output file /Users/jan/Movies/Reels/.reel.1a2b.part.mp4.',
  'Error opening output files: Permission denied'
].join('\n')
const INPUT_DENIED = [
  '[in#0 @ 0x7b7d010000] Error opening input: Permission denied',
  'Error opening input file /Users/jan/Desktop/Festival/clip.mov.',
  'Error opening input files: Permission denied'
].join('\n')
const CONCAT_ENTRY_DENIED = [
  "[in#0 @ 0x74aec10000] Impossible to open '/work/tmp/export-1/clip-001.mov'",
  '[in#0 @ 0x74af01c000] Error opening input: Permission denied',
  'Error opening input file /work/tmp/export-1/concat.txt.',
  'Error opening input files: Permission denied'
].join('\n')
const FFPROBE_DENIED = '/Users/jan/Desktop/Festival/clip.mov: Operation not permitted'
const DISK_FULL = [
  '[mp4 @ 0x7d2a00c000] Error writing packet: No space left on device',
  '[out#0/mp4 @ 0x7d2a018000] Error muxing a packet',
  '[out#0/mp4 @ 0x7d2a018000] Error writing trailer: No space left on device'
].join('\n')

describe('environmentFailure', () => {
  const files = {
    inputs: ['/Users/jan/Desktop/Festival/clip.mov'],
    output: '/Users/jan/Movies/Reels/.reel.1a2b.part.mp4'
  }

  it('recognises a full disk on any side', () => {
    expect(environmentFailure(DISK_FULL, files)).toBe(
      'There is not enough free space on your Mac. Free up some space and try again.'
    )
    expect(environmentFailure('av_interleaved_write_frame(): No space left on device', files)).toBe(
      MESSAGES.diskFull
    )
  })

  it('recognises a full quota in both spellings – macOS says "Disc quota exceeded"', () => {
    for (const quota of ['Disc quota exceeded', 'Disk quota exceeded']) {
      const stderr = `[out#0/mp4 @ 0x1] Error writing trailer: ${quota}\nConversion failed!`
      expect(environmentFailure(stderr, files)).toBe(MESSAGES.diskFull)
      // no other encoder or the first-frame poster retry can help with it
      expect(isEnvironmentFailure(new MediaError('ffmpeg', MESSAGES.proxy, stderr))).toBe(true)
    }
  })

  it('names the output folder when it cannot be written', () => {
    expect(environmentFailure(OUTPUT_DENIED, files)).toBe(
      'Glimpse is not allowed to write to the folder “/Users/jan/Movies/Reels”. ' +
        'Check the folder’s permissions or choose another one.'
    )
    expect(environmentFailure('Error opening output files: Read-only file system', files)).toBe(
      MESSAGES.writeDenied('/Users/jan/Movies/Reels')
    )
  })

  it('names the folder of an input that cannot be read', () => {
    const expected = MESSAGES.readDenied('/Users/jan/Desktop/Festival')
    expect(expected).toBe(
      'Glimpse is not allowed to access the folder “/Users/jan/Desktop/Festival”. ' +
        'Check the permissions or allow access in System Settings under “Privacy & Security”.'
    )
    expect(environmentFailure(INPUT_DENIED, files)).toBe(expected)
    expect(environmentFailure(FFPROBE_DENIED, { inputs: files.inputs })).toBe(expected)
    // a file listed in a concat list: the file that could not be opened, not the list
    expect(
      environmentFailure(CONCAT_ENTRY_DENIED, { inputs: ['/work/tmp/export-1/concat.txt'] })
    ).toBe(MESSAGES.readDenied('/work/tmp/export-1'))
  })

  it('leaves every other failure to the caller', () => {
    expect(environmentFailure('Invalid data found when processing input', files)).toBeNull()
    expect(environmentFailure('', files)).toBeNull()
    expect(
      environmentFailure(
        '[h264_videotoolbox @ 0x1] Error: cannot create compression session',
        files
      )
    ).toBeNull()
  })
})

describe('filesOfArgs', () => {
  it('finds the inputs and the output (the last argument)', () => {
    expect(
      filesOfArgs(['-ss', '1', '-i', '/a.mov', '-i', '/b.mov', '-c', 'copy', '/out.mp4'])
    ).toEqual({ inputs: ['/a.mov', '/b.mov'], output: '/out.mp4' })
    expect(filesOfArgs(['-i', '/a.mov', '-f', 'null', '-'])).toEqual({
      inputs: ['/a.mov'],
      output: undefined
    })
  })
})

describe('fsFailure', () => {
  const errno = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`${code}: failed`), { code })

  it('maps a full disk and missing permissions, nothing else', () => {
    expect(fsFailure(errno('ENOSPC'), '/work', 'write')).toBe(MESSAGES.diskFull)
    expect(fsFailure(errno('EACCES'), '/work', 'write')).toBe(MESSAGES.writeDenied('/work'))
    expect(fsFailure(errno('EPERM'), '/Users/jan/Desktop', 'read')).toBe(
      MESSAGES.readDenied('/Users/jan/Desktop')
    )
    expect(fsFailure(errno('EROFS'), '/Volumes/Card', 'write')).toBe(
      MESSAGES.writeDenied('/Volumes/Card')
    )
    expect(fsFailure(errno('ENOENT'), '/work', 'write')).toBeNull()
    expect(fsFailure(new Error('plain'), '/work', 'write')).toBeNull()
    expect(fsFailure(undefined, '/work', 'write')).toBeNull()
  })
})

describe('isEnvironmentFailure', () => {
  it('is true for ffmpeg failures no fallback can fix', () => {
    expect(isEnvironmentFailure(new MediaError('ffmpeg', MESSAGES.diskFull, DISK_FULL))).toBe(true)
    expect(isEnvironmentFailure(new MediaError('ffmpeg', 'x', OUTPUT_DENIED))).toBe(true)
    expect(isEnvironmentFailure(new MediaError('ffmpeg', MESSAGES.diskFull))).toBe(true)
    expect(isEnvironmentFailure(new MediaError('ffmpeg', 'x', 'VTCompressionSessionCreate'))).toBe(
      false
    )
    expect(isEnvironmentFailure(new MediaError('cancelled', 'Cancelled.'))).toBe(false)
    expect(isEnvironmentFailure(new Error('No space left on device'))).toBe(false)
  })
})

describe('user-facing failure texts', () => {
  it('give a next step for clip, join and save failures', () => {
    expect(MESSAGES.clipFailed(2, 11)).toBe(
      'Clip 3 of 11 could not be rendered. Try again or remove the clip from the highlight video.'
    )
    expect(MESSAGES.join).toMatch(/Try again/)
    expect(MESSAGES.save).toMatch(/try again\.$/)
  })
})
