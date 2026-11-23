import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { makeSprite, SPRITE_MAX_TILES, spriteArgs, spriteLayout } from './sprite'
import type { Toolchain } from './toolchain'
import { LOCAL_VIDEO_INPUT } from './ffargs'

const runFfmpeg = vi.hoisted(() => vi.fn())
vi.mock('./runner', () => ({ runFfmpeg }))
vi.mock('./probe', () => ({
  probeFile: vi.fn(async () => ({ durationSec: 12, fps: 30, width: 720, height: 960 }))
}))

const portraitProxy = { width: 720, height: 960 }

describe('spriteLayout', () => {
  it.each([
    // duration, interval, columns
    [0.5, 1, 1],
    [10, 1, 10],
    [10.5, 1, 11],
    [119.9, 1, 120],
    [120, 1, 120],
    [120.5, 2, 61],
    [300, 3, 100],
    [360, 3, 120],
    [361, 4, 91],
    [3600, 30, 120]
  ])('%s s → every %s s, %s tiles', (duration, interval, columns) => {
    const layout = spriteLayout(duration, 30, portraitProxy)
    expect(layout.intervalSec).toBe(interval)
    expect(layout.columns).toBe(columns)
    expect(layout.columns).toBeLessThanOrEqual(SPRITE_MAX_TILES)
    // the last tile starts before the last frame
    expect((layout.columns - 1) * layout.intervalSec).toBeLessThan(duration)
  })

  it('derives an even tile height from the frame aspect', () => {
    expect(spriteLayout(10, 30, portraitProxy)).toMatchObject({ tileWidth: 160, tileHeight: 214 })
    expect(spriteLayout(10, 30, { width: 1280, height: 720 })).toMatchObject({ tileHeight: 90 })
    expect(spriteLayout(10, 30, { width: 720, height: 1280 })).toMatchObject({ tileHeight: 284 })
  })
})

describe('spriteArgs', () => {
  it('selects one keyframe per interval into a single row', () => {
    const args = spriteArgs('/in/proxy.mp4', '/out/sprite.jpg', {
      columns: 100,
      intervalSec: 3,
      tileWidth: 160,
      tileHeight: 214
    })
    expect(args.slice(0, 8)).toEqual([
      '-skip_frame',
      'nokey',
      ...LOCAL_VIDEO_INPUT,
      '-i',
      '/in/proxy.mp4'
    ])
    const filter = args[args.indexOf('-vf') + 1]
    expect(filter).toBe(
      "select='gte(t,selected_n*3)',scale=160:214,tpad=stop_mode=clone:stop=2,tile=100x1"
    )
    expect(args.slice(-7)).toEqual([
      '-frames:v',
      '1',
      '-q:v',
      '5',
      '-update',
      '1',
      '/out/sprite.jpg'
    ])
  })
})

describe('makeSprite', () => {
  it('gives ffmpeg a time limit that grows with the video, so a hung ffmpeg ends', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hc-sprite-'))
    try {
      runFfmpeg.mockImplementationOnce(async (_bin: string, args: string[]) => {
        await writeFile(args.at(-1) as string, 'sprite')
      })
      const tc = { ffmpeg: '/bin/ffmpeg', ffprobe: '/bin/ffprobe' } as Toolchain
      await makeSprite(tc, '/in/proxy.mp4', join(dir, 'sprite.jpg'), { durationSec: 0 })
      // the length ffprobe reports for the proxy, not the caller's fallback
      expect(runFfmpeg.mock.calls[0][2].timeoutMs).toBe(360_000)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
