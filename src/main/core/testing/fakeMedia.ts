// In-memory MediaService for core tests: writes small placeholder files, reports progress,
// honours AbortSignals and can hold or fail individual steps.

import type { FfmpegStatus, SpriteInfo } from '@shared/types'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  MediaError,
  type MediaService,
  type ProbeResult,
  type RenderJob,
  type RenderProgress,
  type RenderResult
} from '../../contracts'
import { createGate, type Gate, type GateControl } from './gate'

export const FAKE_FFMPEG_OK: FfmpegStatus = {
  ok: true,
  ffmpegPath: '/Applications/Glimpse.app/Contents/Resources/ffmpeg/ffmpeg',
  ffprobePath: '/Applications/Glimpse.app/Contents/Resources/ffmpeg/ffprobe',
  version: '9.0.2',
  hardwareEncoders: ['h264_videotoolbox']
}

export const FAKE_FFMPEG_MISSING: FfmpegStatus = {
  ok: false,
  ffmpegPath: null,
  ffprobePath: null,
  version: null,
  hardwareEncoders: [],
  error: 'ffmpeg was not found.'
}

type Step = 'status' | 'probe' | 'poster' | 'proxy' | 'analysisCopy' | 'sprite' | 'render'

const cancelled = (): MediaError => new MediaError('cancelled', 'Cancelled.')

async function writePlaceholder(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

export class FakeMedia implements MediaService {
  statusResult: FfmpegStatus = FAKE_FFMPEG_OK
  /** probe results by input path (merged over a 60 s portrait default) */
  readonly probes = new Map<string, Partial<ProbeResult>>()
  /** steps that fail for the given input path */
  readonly failures = new Map<string, { step: Step; error: Error }>()
  renderError: Error | null = null
  readonly calls = {
    probe: [] as string[],
    poster: [] as string[],
    proxy: [] as string[],
    analysisCopy: [] as string[],
    sprite: [] as string[],
    render: [] as RenderJob[],
    fingerprint: [] as string[]
  }
  /** highest number of proxies rendered at the same time */
  maxParallelProxies = 0
  private parallelProxies = 0
  private readonly gates = new Map<Step, GateControl>()

  /** holds every later call of `step` until released */
  hold(step: Step): Gate {
    const gate = createGate()
    this.gates.set(step, gate)
    return gate
  }

  private async passGate(step: Step, signal?: AbortSignal): Promise<void> {
    await this.gates.get(step)?.pass(signal, cancelled)
  }

  private failIfConfigured(step: Step, input: string): void {
    const failure = this.failures.get(input)
    if (failure?.step === step) throw failure.error
  }

  async status(): Promise<FfmpegStatus> {
    await this.passGate('status')
    return this.statusResult
  }

  async probe(path: string): Promise<ProbeResult> {
    this.calls.probe.push(path)
    this.failIfConfigured('probe', path)
    const size = (await stat(path)).size
    return {
      durationSec: 60,
      width: 1440,
      height: 1920,
      fps: 30,
      videoCodec: 'h264',
      hasAudio: true,
      recordedAt: null,
      sizeBytes: size,
      ...this.probes.get(path)
    }
  }

  async fingerprint(path: string): Promise<string> {
    this.calls.fingerprint.push(path)
    const content = await readFile(path)
    return `${content.length}-${createHash('sha1').update(content).digest('hex')}`
  }

  async makePoster(input: string, outPath: string): Promise<void> {
    this.calls.poster.push(input)
    this.failIfConfigured('poster', input)
    await this.passGate('poster')
    await writePlaceholder(outPath, `poster of ${input}`)
  }

  async makeProxy(
    input: string,
    outPath: string,
    opts: { durationSec: number; onProgress?: (fraction: number) => void; signal?: AbortSignal }
  ): Promise<void> {
    this.calls.proxy.push(input)
    this.parallelProxies++
    this.maxParallelProxies = Math.max(this.maxParallelProxies, this.parallelProxies)
    try {
      if (opts.signal?.aborted) throw cancelled()
      opts.onProgress?.(0)
      await this.passGate('proxy', opts.signal)
      this.failIfConfigured('proxy', input)
      opts.onProgress?.(0.5)
      opts.onProgress?.(1)
      await writePlaceholder(outPath, `proxy of ${input}`)
    } finally {
      this.parallelProxies--
    }
  }

  async makeAnalysisCopy(
    input: string,
    outPath: string,
    opts: { signal?: AbortSignal }
  ): Promise<void> {
    this.calls.analysisCopy.push(input)
    if (opts.signal?.aborted) throw cancelled()
    await this.passGate('analysisCopy', opts.signal)
    this.failIfConfigured('analysisCopy', input)
    // follows the proxy's content like the real copy: a rebuilt proxy gives another fingerprint
    await writePlaceholder(outPath, `analysis copy of ${await readFile(input, 'utf8')}`)
  }

  async makeSprite(
    input: string,
    outPath: string,
    opts: { durationSec: number; signal?: AbortSignal }
  ): Promise<SpriteInfo> {
    this.calls.sprite.push(input)
    if (opts.signal?.aborted) throw cancelled()
    await this.passGate('sprite', opts.signal)
    this.failIfConfigured('sprite', input)
    await writePlaceholder(outPath, `sprite of ${input}`)
    const columns = Math.min(120, Math.ceil(opts.durationSec))
    return { columns, intervalSec: 1, tileWidth: 160, tileHeight: 213 }
  }

  async renderHighlight(
    job: RenderJob,
    opts: { onProgress?: (p: RenderProgress) => void; signal?: AbortSignal }
  ): Promise<RenderResult> {
    this.calls.render.push(structuredClone(job))
    const clipCount = job.clips.length
    await writePlaceholder(`${job.workDir}/clip-0.mov`, 'intermediate')
    for (let i = 0; i < clipCount; i++) {
      if (opts.signal?.aborted) throw cancelled()
      opts.onProgress?.({
        phase: 'rendering',
        clipIndex: i,
        clipCount,
        fraction: (0.85 * (i + 0.5)) / clipCount
      })
      if (i === 0) await this.passGate('render', opts.signal)
    }
    if (this.renderError) throw this.renderError
    opts.onProgress?.({ phase: 'joining', clipCount, fraction: 0.9 })
    opts.onProgress?.({ phase: 'finishing', clipCount, fraction: 0.99 })
    await writePlaceholder(job.outputPath, 'highlight video')
    const durationSec = job.clips.reduce((sum, clip) => sum + clip.end - clip.start, 0)
    return { outputPath: job.outputPath, durationSec, sizeBytes: 15 }
  }
}
