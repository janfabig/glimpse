// Opt-in benchmark (takes a few minutes): HC_MEDIA_PERF=1 npx vitest run src/main/media/media.perf
// Generates a realistic 5-minute 1440×1920 30 fps H.264 clip with audio (sensor-like noise,
// ~14 Mbit/s) in a temp dir, measures proxy/sprite/render times and deletes everything afterwards.
//   HC_MEDIA_PERF_OUT=<file>     also write the results to this file
//   HC_MEDIA_PERF_SOURCE=<file>  reuse an existing 5-minute 1440×1920 clip (kept afterwards)
import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_EXPORT_SETTINGS, EXPORT_FIXED } from '@shared/presets'
import type { ExportSettings } from '@shared/types'
import type { RenderJob } from '../contracts'
import { createMediaService } from './index'
import { makeProxy } from './proxy'
import { ffprobe, FFMPEG } from './testHelpers'
import { createToolchainLoader } from './toolchain'

const enabled = process.env.HC_MEDIA_PERF === '1'
const reusedSource = process.env.HC_MEDIA_PERF_SOURCE
const SOURCE_SEC = 300
const media = createMediaService()
const results: string[] = []
let dir: string
let source: string

async function timed<T>(label: string, task: () => Promise<T>): Promise<T> {
  const started = performance.now()
  const result = await task()
  results.push(`${label}: ${((performance.now() - started) / 1000).toFixed(1)} s`)
  return result
}

const megabytes = async (path: string): Promise<string> =>
  `${((await stat(path)).size / 1024 / 1024).toFixed(1)} MB`

describe.runIf(enabled)('media performance (5-minute Meta-glasses-like clip)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hc-perf-'))
    if (reusedSource) {
      source = reusedSource
      return
    }
    source = join(dir, 'five-minutes.mp4')
    // prettier-ignore
    await timed('generate source', () =>
      promisify(execFile)(FFMPEG, [
        '-v', 'error', '-y',
        '-f', 'lavfi', '-i', `testsrc2=s=1440x1920:r=30:d=${SOURCE_SEC},noise=alls=24:allf=t+u,hue=h=t*12`,
        '-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.08:sample_rate=48000:d=${SOURCE_SEC}`,
        '-map', '0:v', '-map', '1:a', '-ac', '2',
        '-c:v', 'h264_videotoolbox', '-b:v', '14M', '-profile:v', 'high', '-g', '30',
        '-c:a', 'aac', '-b:a', '192k', source
      ])
    )
    results.push(`source: ${await megabytes(source)}`)
  }, 600_000)

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
    const report = `Media benchmark (${process.platform}/${process.arch}):\n  ${results.join('\n  ')}\n`
    console.log(report)
    if (process.env.HC_MEDIA_PERF_OUT) await writeFile(process.env.HC_MEDIA_PERF_OUT, report)
  })

  it('makeProxy: VideoToolbox with GPU scaling (default), with CPU scaling, libx264', async () => {
    const proxy = join(dir, 'proxy.mp4')
    await timed('makeProxy (default: VideoToolbox, GPU scaling)', () =>
      media.makeProxy(source, proxy, { durationSec: SOURCE_SEC })
    )
    results.push(`proxy size (VideoToolbox): ${await megabytes(proxy)}`)
    expect((await ffprobe(proxy)).video.width).toBe(720)

    const tc = await createToolchainLoader().ready()
    await timed('makeProxy (VideoToolbox, CPU scaling)', () =>
      makeProxy(tc, source, join(dir, 'proxy-cpu-scaling.mp4'), { durationSec: SOURCE_SEC }, [
        { encoder: 'h264_videotoolbox', hwDecode: true }
      ])
    )
    const software = join(dir, 'proxy-sw.mp4')
    await timed('makeProxy (libx264 software)', () =>
      makeProxy(tc, source, software, { durationSec: SOURCE_SEC }, [
        { encoder: 'libx264', hwDecode: false }
      ])
    )
    results.push(`proxy size (libx264): ${await megabytes(software)}`)

    const sprite = await timed('makeSprite', () =>
      media.makeSprite(proxy, join(dir, 'sprite.jpg'), { durationSec: SOURCE_SEC })
    )
    expect(sprite.columns).toBe(100)
  }, 600_000)

  const reel = (name: string, patch: Partial<ExportSettings>): RenderJob => ({
    // 3 clips of 1 s spread over the source: more at 4K would not be safe on a Mac with 8 GB
    clips: Array.from({ length: 3 }, (_, i) => ({
      sourcePath: source,
      start: 7 + i * 96,
      end: 8 + i * 96,
      hasAudio: true,
      sourceWidth: 1440,
      sourceHeight: 1920
    })),
    settings: { ...DEFAULT_EXPORT_SETTINGS, aspect: '9:16', ...patch },
    frame: EXPORT_FIXED,
    outputPath: join(dir, 'out', `${name}.mp4`),
    workDir: join(dir, `work-${name}`)
  })

  it.each([
    ['cut', { transition: 'cut' }],
    ['crossfade', { transition: 'crossfade' }]
  ] as const)(
    'renderHighlight 3 × 1 s at 2160×3840 (%s)',
    async (name, patch) => {
      const job = reel(name, patch)
      const started = performance.now()
      let joinStarted = 0
      const result = await timed(`renderHighlight 3×1 s 2160×3840 ${name}`, () =>
        media.renderHighlight(job, {
          onProgress: (p) => {
            if (p.phase === 'joining' && !joinStarted) joinStarted = performance.now()
          }
        })
      )
      const clipsSec = (joinStarted - started) / 1000
      const joinSec = (performance.now() - joinStarted) / 1000
      results.push(
        `  → ${result.durationSec.toFixed(2)} s, ${await megabytes(result.outputPath)}; ` +
          `clips ≈ ${clipsSec.toFixed(1)} s, join ≈ ${joinSec.toFixed(1)} s`
      )
      await rm(job.workDir, { recursive: true, force: true })
      expect(result.durationSec).toBeGreaterThan(2)
    },
    600_000
  )
})
