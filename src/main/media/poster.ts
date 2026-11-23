import { MediaError } from '../contracts'
import { isEnvironmentFailure, MESSAGES } from './errors'
import { formatSeconds, LOCAL_VIDEO_INPUT, POSTER_TIMEOUT_MS } from './ffargs'
import { fileSize, writeAtomically } from './fsutil'
import { runFfmpeg } from './runner'
import type { Toolchain } from './toolchain'

export const POSTER_MAX_SIDE = 640

/** One upright JPEG frame (fast input seek; autorotation is ffmpeg's default), longest side ≤ 640. */
export function posterArgs(input: string, output: string, atSec: number): string[] {
  const max = POSTER_MAX_SIDE
  return [
    '-ss',
    formatSeconds(atSec),
    ...LOCAL_VIDEO_INPUT,
    '-i',
    input,
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-vf',
    `scale=w='min(${max},iw)':h='min(${max},ih)':force_original_aspect_ratio=decrease`,
    '-q:v',
    '4',
    '-update',
    '1',
    output
  ]
}

export async function makePoster(
  tc: Toolchain,
  input: string,
  outPath: string,
  atSec: number
): Promise<void> {
  const at = Number.isFinite(atSec) ? Math.max(0, atSec) : 0
  const run = { errorMessage: MESSAGES.poster, timeoutMs: POSTER_TIMEOUT_MS }
  await writeAtomically(outPath, async (tempPath) => {
    try {
      await runFfmpeg(tc.ffmpeg, posterArgs(input, tempPath, at), run)
    } catch (err) {
      // a position at (or past) the end yields no frame – take the first frame instead
      const noFrame = err instanceof MediaError && err.code === 'ffmpeg'
      if (at === 0 || !noFrame || isEnvironmentFailure(err)) throw err
      await runFfmpeg(tc.ffmpeg, posterArgs(input, tempPath, 0), run)
    }
    if ((await fileSize(tempPath)) === 0) throw new MediaError('ffmpeg', MESSAGES.poster)
  })
}
