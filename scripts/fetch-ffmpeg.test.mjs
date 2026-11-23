import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertSha256, FFMPEG_VERSION, PINNED, sha256, vendorPath } from './fetch-ffmpeg.mjs'

describe('fetch-ffmpeg', () => {
  it('pins ffmpeg and ffprobe: one version, https, full sha256 values', () => {
    expect(PINNED.map((tool) => tool.name)).toEqual(['ffmpeg', 'ffprobe'])
    for (const tool of PINNED) {
      expect(tool.url).toBe(
        `https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_${FFMPEG_VERSION}/${tool.name}.zip`
      )
      expect(tool.zipSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(tool.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('pins what vendor/ffmpeg/SOURCE.txt names', () => {
    const source = readFileSync(new URL('../vendor/ffmpeg/SOURCE.txt', import.meta.url), 'utf8')
    expect(source).toContain(`FFmpeg ${FFMPEG_VERSION}`)
    for (const tool of PINNED) {
      expect(source).toContain(tool.url)
      expect(source).toContain(tool.zipSha256)
      expect(source).toContain(tool.sha256)
    }
  })

  it('accepts only data with the pinned checksum', () => {
    const data = Buffer.from('abc')
    const sum = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    expect(sha256(data)).toBe(sum)
    expect(() => assertSha256('ffmpeg.zip', data, sum)).not.toThrow()
    expect(() => assertSha256('ffmpeg.zip', Buffer.from('abd'), sum)).toThrow(
      /ffmpeg\.zip has the wrong checksum.*expected ba7816bf.*got +[0-9a-f]{64}$/s
    )
    expect(() => assertSha256('ffmpeg.zip', data, '')).toThrow()
  })

  it('puts the binaries into vendor/ffmpeg of the repo', () => {
    expect(vendorPath('/repo', 'ffmpeg')).toBe('/repo/vendor/ffmpeg/ffmpeg')
    expect(vendorPath('/repo', 'ffprobe')).toBe('/repo/vendor/ffmpeg/ffprobe')
    // only the two tools, never a path out of the folder
    expect(() => vendorPath('/repo', '../../etc/passwd')).toThrow()
    expect(() => vendorPath('/repo', 'ffplay')).toThrow()
  })
})
