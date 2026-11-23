// Media module: everything that touches ffmpeg/ffprobe (see docs/ARCHITECTURE.md §6).
import { resolve } from 'node:path'
import type { MediaService } from '../contracts'
import { fingerprintFile } from './fingerprint'
import { makePoster } from './poster'
import { probeFile } from './probe'
import { makeAnalysisCopy, makeProxy } from './proxy'
import { renderHighlight } from './render/renderHighlight'
import { makeSprite } from './sprite'
import type { MediaLogger } from './toolchain'
import { createToolchainLoader } from './toolchain'

export type { MediaLogger } from './toolchain'
export { appFfmpegDirs } from './toolchain'

export interface MediaServiceOptions {
  /**
   * explicit binaries (tests); otherwise resolved via HC_FFMPEG/HC_FFPROBE, `vendorDir`, Homebrew,
   * PATH
   */
  ffmpegPath?: string
  ffprobePath?: string
  /** the packaged app: the folder with its own ffmpeg and ffprobe, nothing else is used */
  bundledDir?: string
  /** development: the repo's vendor/ffmpeg */
  vendorDir?: string
  /** false → never use VideoToolbox (troubleshooting, tests of the software path); default true */
  hardwareAcceleration?: boolean
  /** receives warnings such as hardware → software fallbacks; default: console.warn */
  logger?: MediaLogger
}

export function createMediaService(options: MediaServiceOptions = {}): MediaService {
  const toolchain = createToolchainLoader(options)
  const ready = toolchain.ready

  return {
    status: () => toolchain.status(),
    probe: async (path) => probeFile((await ready()).ffprobe, resolve(path)),
    fingerprint: (path) => fingerprintFile(resolve(path)),
    makePoster: async (input, outPath, atSec) =>
      makePoster(await ready(), resolve(input), resolve(outPath), atSec),
    makeProxy: async (input, outPath, opts) => {
      await makeProxy(await ready(), resolve(input), resolve(outPath), opts)
    },
    makeAnalysisCopy: async (input, outPath, opts) =>
      makeAnalysisCopy(await ready(), resolve(input), resolve(outPath), opts),
    makeSprite: async (input, outPath, opts) =>
      makeSprite(await ready(), resolve(input), resolve(outPath), opts),
    renderHighlight: async (job, opts) =>
      renderHighlight(
        await ready(),
        {
          ...job,
          clips: job.clips.map((clip) => ({ ...clip, sourcePath: resolve(clip.sourcePath) })),
          outputPath: resolve(job.outputPath),
          workDir: resolve(job.workDir)
        },
        opts
      )
  }
}
