import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { makePoster, posterArgs } from './poster'
import type { Toolchain } from './toolchain'
import { LOCAL_VIDEO_INPUT } from './ffargs'

const runFfmpeg = vi.hoisted(() => vi.fn())
vi.mock('./runner', () => ({ runFfmpeg }))

describe('posterArgs', () => {
  it('seeks on the input and fits the frame into 640×640 without upscaling', () => {
    expect(posterArgs('/in/clip.mov', '/out/poster.jpg', 12.5)).toEqual([
      '-ss',
      '12.5',
      ...LOCAL_VIDEO_INPUT,
      '-i',
      '/in/clip.mov',
      '-map',
      '0:v:0',
      '-frames:v',
      '1',
      '-vf',
      "scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease",
      '-q:v',
      '4',
      '-update',
      '1',
      '/out/poster.jpg'
    ])
  })

  it('never passes negative or exponent-formatted times', () => {
    expect(posterArgs('/a', '/b', -3)[1]).toBe('0')
    expect(posterArgs('/a', '/b', 0.0000001)[1]).toBe('0')
    expect(posterArgs('/a', '/b', 1 / 3)[1]).toBe('0.333333')
  })
})

describe('makePoster', () => {
  it('gives ffmpeg a time limit, so a file that never answers cannot hold up an import', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hc-poster-'))
    try {
      runFfmpeg.mockImplementation(async (_bin: string, args: string[]) => {
        await writeFile(args.at(-1) as string, 'jpeg')
      })
      await makePoster({ ffmpeg: '/bin/ffmpeg' } as Toolchain, '/in.mov', join(dir, 'p.jpg'), 2)
      expect(runFfmpeg.mock.calls[0][2].timeoutMs).toBe(60_000)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
