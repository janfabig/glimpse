import { describe, expect, it } from 'vitest'
import { devBinary } from './testVideos'

describe('devBinary (ffmpeg for tests and scripts)', () => {
  const only =
    (...present: string[]) =>
    (path: string): boolean =>
      present.includes(path)

  it('uses the repo’s vendor/ffmpeg and needs no Homebrew', () => {
    const exists = only('/repo/vendor/ffmpeg/ffmpeg', '/repo/vendor/ffmpeg/ffprobe')
    expect(devBinary('ffmpeg', '/repo', {}, exists)).toBe('/repo/vendor/ffmpeg/ffmpeg')
    expect(devBinary('ffprobe', '/repo', {}, exists)).toBe('/repo/vendor/ffmpeg/ffprobe')
  })

  it('HC_FFMPEG / HC_FFPROBE come first', () => {
    const exists = only('/repo/vendor/ffmpeg/ffmpeg', '/repo/vendor/ffmpeg/ffprobe')
    const env = { HC_FFMPEG: '/e/ffmpeg', HC_FFPROBE: ' /e/ffprobe ' }
    expect(devBinary('ffmpeg', '/repo', env, exists)).toBe('/e/ffmpeg')
    expect(devBinary('ffprobe', '/repo', env, exists)).toBe('/e/ffprobe')
    expect(devBinary('ffmpeg', '/repo', { HC_FFMPEG: ' ' }, exists)).toBe(
      '/repo/vendor/ffmpeg/ffmpeg'
    )
  })

  it('falls back to Homebrew only while the repo’s copy is not fetched', () => {
    expect(devBinary('ffmpeg', '/repo', {}, only())).toBe('/opt/homebrew/bin/ffmpeg')
    expect(devBinary('ffprobe', '/repo', {}, only('/repo/vendor/ffmpeg/ffmpeg'))).toBe(
      '/opt/homebrew/bin/ffprobe'
    )
  })
})
