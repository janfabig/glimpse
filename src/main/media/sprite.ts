import type { SpriteInfo } from '@shared/types'
import { MediaError } from '../contracts'
import { MESSAGES, throwIfAborted } from './errors'
import { LOCAL_VIDEO_INPUT, videoRunTimeoutMs } from './ffargs'
import { fileSize, writeAtomically } from './fsutil'
import type { Size } from './geometry'
import { evenRound } from './geometry'
import { probeFile } from './probe'
import { runFfmpeg } from './runner'
import type { Toolchain } from './toolchain'

export const SPRITE_TILE_WIDTH = 160
export const SPRITE_MAX_TILES = 120

/**
 * Tile i shows t = i · intervalSec. intervalSec = max(1, ceil(duration / 120)); there is one tile
 * per interval start that lies before the last frame.
 */
export function spriteLayout(durationSec: number, fps: number, size: Size): SpriteInfo {
  const intervalSec = Math.max(1, Math.ceil(durationSec / SPRITE_MAX_TILES))
  const lastFrameSec = Math.max(0, durationSec - 1 / (fps > 0 ? fps : 30))
  const columns = Math.min(SPRITE_MAX_TILES, Math.floor(lastFrameSec / intervalSec) + 1)
  return {
    columns,
    intervalSec,
    tileWidth: SPRITE_TILE_WIDTH,
    tileHeight: evenRound((SPRITE_TILE_WIDTH * size.height) / size.width)
  }
}

export function spriteArgs(input: string, output: string, layout: SpriteInfo): string[] {
  const select = `select='gte(t,selected_n*${layout.intervalSec})'`
  return [
    // Proxies have a keyframe at every full second (see proxyArgs), so decoding keyframes only
    // yields exactly the frames we need at a fraction of the cost.
    '-skip_frame',
    'nokey',
    ...LOCAL_VIDEO_INPUT,
    '-i',
    input,
    '-map',
    '0:v:0',
    '-vf',
    // tpad: repeat the last frame instead of leaving a black tile if one frame is missing
    `${select},scale=${layout.tileWidth}:${layout.tileHeight},tpad=stop_mode=clone:stop=2,` +
      `tile=${layout.columns}x1`,
    '-frames:v',
    '1',
    '-q:v',
    '5',
    '-update',
    '1',
    output
  ]
}

/** Single-row filmstrip JPEG from the proxy. */
export async function makeSprite(
  tc: Toolchain,
  input: string,
  outPath: string,
  opts: { durationSec: number; signal?: AbortSignal }
): Promise<SpriteInfo> {
  throwIfAborted(opts.signal)
  const info = await probeFile(tc.ffprobe, input, opts.signal)
  const durationSec = info.durationSec || opts.durationSec
  const layout = spriteLayout(durationSec, info.fps, info)
  await writeAtomically(outPath, async (tempPath) => {
    await runFfmpeg(tc.ffmpeg, spriteArgs(input, tempPath, layout), {
      errorMessage: MESSAGES.sprite,
      signal: opts.signal,
      timeoutMs: videoRunTimeoutMs(durationSec)
    })
    if ((await fileSize(tempPath)) === 0) throw new MediaError('ffmpeg', MESSAGES.sprite)
  })
  return layout
}
