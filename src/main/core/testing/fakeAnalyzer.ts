// Deterministic Analyzer for core tests: emits the usual stages, reports its upload through
// onRemoteFile, honours AbortSignals and can hold, fail or return custom moments per video file name.

import type { ApiKeyTestResult, ModelOption, RemoteFileRef } from '@shared/types'
import {
  AnalyzerError,
  type AnalyzedMoment,
  type Analyzer,
  type AnalyzeRequest,
  type AnalyzeResponse
} from '../../contracts'
import { createGate, type Gate, type GateControl } from './gate'

const cancelled = (): AnalyzerError => new AnalyzerError('cancelled', 'Cancelled.')

/** three 4-second moments spread over the video, scores 9 / 7 / 5 */
export function defaultMoments(durationSec: number): AnalyzedMoment[] {
  return [0.2, 0.5, 0.8].map((at, i) => {
    const start = Math.round(durationSec * at)
    return {
      start,
      end: start + 4,
      title: `Moment ${i + 1}`,
      reason: 'Something happens here.',
      score: 9 - 2 * i
    }
  })
}

export class FakeAnalyzer implements Analyzer {
  /** moments by video file name */
  readonly results = new Map<string, AnalyzedMoment[]>()
  /** errors by video file name – thrown once the upload is active (after onRemoteFile) */
  readonly errors = new Map<string, Error>()
  readonly calls: AnalyzeRequest[] = []
  /** every file "uploaded" (reused files are not uploaded again) */
  readonly uploads: RemoteFileRef[] = []
  /** deleteRemoteFile calls (core cleaning up) */
  readonly deleted: string[] = []
  /** uploads the analyzer removed itself: cancelled while "Gemini processed" them */
  readonly discarded: string[] = []
  /** false simulates an implementation that does not react to its AbortSignal */
  honourAbort = true
  /** highest number of analyses running at the same time */
  maxParallel = 0
  private parallel = 0
  private readonly uploadCounts = new Map<string, number>()
  private gate: GateControl | null = null
  private readonly videoGates = new Map<string, GateControl>()
  private uploadGate: GateControl | null = null
  private processingGate: GateControl | null = null
  private deleteGate: GateControl | null = null

  /** holds every later analysis in the "analyzing" stage (its upload is active) until released */
  hold(): Gate {
    this.gate = createGate()
    return this.gate
  }

  /** like hold(), for the analyses of one video file only */
  holdVideo(fileName: string): Gate {
    const gate = createGate()
    this.videoGates.set(fileName, gate)
    return gate
  }

  /** holds every later upload before it becomes active (no onRemoteFile yet) */
  holdUpload(): Gate {
    this.uploadGate = createGate()
    return this.uploadGate
  }

  /**
   * holds every later analysis after its upload, while "Gemini processes" it (stage processing,
   * no onRemoteFile yet). Cancelled there, the fake deletes that upload in the background and
   * hands the delete over through onCleanup – like the Gemini analyzer.
   */
  holdProcessing(): Gate {
    this.processingGate = createGate()
    return this.processingGate
  }

  /** holds every later deleteRemoteFile until released */
  holdDeletes(): Gate {
    this.deleteGate = createGate()
    return this.deleteGate
  }

  /** first upload of a.mp4: "files/a.mp4", later ones "files/a.mp4-2", "files/a.mp4-3" … */
  private upload(req: AnalyzeRequest): RemoteFileRef {
    const count = (this.uploadCounts.get(req.video.fileName) ?? 0) + 1
    this.uploadCounts.set(req.video.fileName, count)
    const name = `files/${req.video.fileName}${count === 1 ? '' : `-${count}`}`
    const file: RemoteFileRef = {
      name,
      uri: `https://example.invalid/${name}`,
      mimeType: 'video/mp4',
      expiresAt: '2026-07-14T20:00:00.000Z',
      proxyFingerprint: req.video.proxyFingerprint
    }
    this.uploads.push(file)
    return file
  }

  async analyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
    this.calls.push(req)
    this.parallel++
    this.maxParallel = Math.max(this.maxParallel, this.parallel)
    try {
      const { signal } = req
      const abortSignal = this.honourAbort ? signal : undefined
      if (signal?.aborted) throw cancelled()
      let file: RemoteFileRef
      if (req.remoteFile && req.remoteFile.proxyFingerprint === req.video.proxyFingerprint) {
        file = req.remoteFile
        req.onStage('processing', -1)
      } else {
        req.onStage('uploading', 0)
        await this.uploadGate?.pass(abortSignal, cancelled)
        req.onStage('uploading', 1)
        file = this.upload(req)
        req.onStage('processing', -1)
        try {
          await this.processingGate?.pass(abortSignal, cancelled)
        } catch (err) {
          // never reported (not ACTIVE yet): only this background delete removes the upload
          const name = file.name
          req.onCleanup?.(
            (async () => {
              await this.deleteGate?.pass(undefined, cancelled)
              this.discarded.push(name)
            })()
          )
          throw err
        }
      }
      req.onRemoteFile(file)
      req.onStage('analyzing', 0.5)
      await this.gate?.pass(abortSignal, cancelled)
      await this.videoGates.get(req.video.fileName)?.pass(abortSignal, cancelled)
      if (this.honourAbort && signal?.aborted) throw cancelled()
      const error = this.errors.get(req.video.fileName)
      if (error) throw error
      return {
        moments: this.results.get(req.video.fileName) ?? defaultMoments(req.video.durationSec),
        model: req.model,
        usage: { promptTokens: 1000, outputTokens: 100, thoughtsTokens: 50, totalTokens: 1150 },
        remoteFile: file
      }
    } finally {
      this.parallel--
    }
  }

  async listModels(): Promise<ModelOption[]> {
    return [{ id: 'gemini-test', displayName: 'Gemini Test', recommended: true }]
  }

  async testKey(apiKey: string): Promise<ApiKeyTestResult> {
    return apiKey.startsWith('bad')
      ? {
          ok: false,
          message: 'Google rejected this API key. Copy it again in full in AI Studio.',
          rejected: true
        }
      : {
          ok: true,
          message: 'Connected: 1 model available',
          models: await this.listModels()
        }
  }

  async deleteRemoteFile(_apiKey: string, name: string): Promise<void> {
    await this.deleteGate?.pass(undefined, cancelled)
    this.deleted.push(name)
  }
}
