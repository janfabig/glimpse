// A file the user picks is opened only as a local video file: a playlist or concat list named .mp4
// must not make ffprobe or ffmpeg read another file (or a URL). Runs the repo's ffmpeg on tiny files.
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { VIDEO_EXTENSIONS } from '@shared/presets'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pathExists } from '../core/fsx'
import { createMediaService } from './index'
import { makePoster } from './poster'
import { makeProxy } from './proxy'
import { FFMPEG } from './testHelpers'
import { createToolchainLoader, type Toolchain } from './toolchain'

const run = promisify(execFile)
const media = createMediaService()
let dir: string
let tc: Toolchain

/** half a second of 160×90 H.264 with AAC in `name`'s container */
async function clip(name: string): Promise<string> {
  const path = join(dir, name)
  // prettier-ignore
  await run(FFMPEG, [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=0.5',
    '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000:d=0.5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    path
  ])
  return path
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hc-inputs-'))
  tc = await createToolchainLoader({ logger: { warn: () => undefined } }).ready()
  await clip('target.mp4')
  await writeFile(
    join(dir, 'playlist.mp4'),
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:0.5,\ntarget.mp4\n#EXT-X-ENDLIST\n'
  )
  await writeFile(join(dir, 'concat.mp4'), "ffconcat version 1.0\nfile 'target.mp4'\n")
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('a list named .mp4 that points at another local file', () => {
  it.each(['playlist.mp4', 'concat.mp4'])('%s: the probe refuses it', async (name) => {
    await expect(media.probe(join(dir, name))).rejects.toThrow()
  })

  it.each(['playlist.mp4', 'concat.mp4'])('%s: the poster refuses it', async (name) => {
    const out = join(dir, `${name}.jpg`)
    await expect(makePoster(tc, join(dir, name), out, 0)).rejects.toThrow()
    expect(await pathExists(out)).toBe(false)
  })

  it.each(['playlist.mp4', 'concat.mp4'])('%s: the preview copy refuses it', async (name) => {
    const out = join(dir, `${name}.proxy.mp4`)
    await expect(makeProxy(tc, join(dir, name), out, { durationSec: 0.5 })).rejects.toThrow()
    expect(await pathExists(out)).toBe(false)
  })
})

describe('every container the import accepts', () => {
  // webm takes VP8/VP9/AV1 only; mkv covers its demuxer (matroska,webm)
  const extensions = VIDEO_EXTENSIONS.filter((extension) => extension !== 'webm')

  it.each(extensions)('.%s is still probed and gets a poster', async (extension) => {
    const path = await clip(`clip.${extension}`)
    expect((await media.probe(path)).durationSec).toBeGreaterThan(0)
    const out = join(dir, `clip.${extension}.jpg`)
    await makePoster(tc, path, out, 0)
    expect(await pathExists(out)).toBe(true)
  })
})
