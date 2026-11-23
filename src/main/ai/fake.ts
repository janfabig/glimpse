// Deterministic stand-in for Gemini (HC_FAKE_AI=1): no network, simulated stages, sample moments.
// The file name picks a failure for E2E tests and UI states (case-insensitive; the earliest stage
// wins when a name matches several):
//   auth   → key rejected, right at the start of the upload
//   fail   → processing error (retryable), before the upload is ACTIVE
//   quota  → daily quota used up (not retryable), while analysing
//   safety → safety block (not retryable), while analysing
// Like the real analyzer, it reports the ACTIVE fake upload via onRemoteFile before analysing.
// A second pass (AnalyzeRequest.earlierClips) returns the same moments; each clip's reason says
// what it got.
import type { ModelOption, RemoteFileRef, TokenUsage } from '@shared/types'
import { clamp, round2 } from '@shared/util'
import {
  AnalyzerError,
  type AnalyzeRequest,
  type AnalyzeResponse,
  type Analyzer
} from '../contracts'
import { throwIfCancelled, toAnalyzerError } from './errors'
import { REUSE_MIN_REMAINING_MS } from './files'
import { MESSAGES } from './messages'
import { dailyQuotaAlternative, MODEL_CATALOG } from './models'
import { normalizeResponse } from './normalize'
import { maxMomentItems } from './prompt'
import { sleep as realSleep, type Sleep } from './retry'

export interface FakeAnalyzerOptions {
  /** duration of one simulated stage (default 450 ms) */
  stageMs?: number
  sleep?: Sleep
  now?: () => number
}

const DEFAULT_STAGE_MS = 450
const UPLOAD_TICKS = [0, 0.25, 0.5, 0.75, 1]
const KEEP_MS = 48 * 60 * 60_000
/** length of every fake moment in seconds, inside the fixed clip length */
const FAKE_CLIP_SEC = 5

const FAKE_MOMENTS = [
  {
    title: 'Drop with light show',
    reason: 'The drop hits and the lights explode above the crowd.'
  },
  {
    title: 'Crowd jumps to the beat',
    reason: 'The whole crowd jumps together to the beat.'
  },
  {
    title: 'Laughing with friends',
    reason: 'You all laugh together at a spontaneous joke.'
  },
  {
    title: 'Clear view of the stage',
    reason: 'A clear view of the stage while the chorus plays.'
  },
  {
    title: 'Confetti rain',
    reason: 'Confetti flies through the air and everyone cheers.'
  },
  {
    title: 'Toast at the bar',
    reason: 'The glasses clink as you all raise a toast.'
  },
  {
    title: 'Everyone sings along',
    reason: 'The crowd sings along loudly to the chorus.'
  },
  {
    title: 'Sunset over the grounds',
    reason: 'The sky turns orange over the festival grounds.'
  }
] as const
const FAKE_SCORES = [9, 7, 8, 5, 10, 6, 8, 4]

/** the two options the fake offers in the model picker */
export const FAKE_MODELS: readonly ModelOption[] = MODEL_CATALOG.filter((option) =>
  ['gemini-3.8-flash', 'gemini-3.5-flash-lite'].includes(option.id)
)

/** small deterministic string hash (FNV-1a) */
function hashOf(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/** A response shaped like Gemini's: as many moments as the schema allows, evenly spread. */
export function fakePayload(req: Pick<AnalyzeRequest, 'video'>): unknown {
  const duration = req.video.durationSec
  const length = Math.min(duration, FAKE_CLIP_SEC)
  const count = maxMomentItems(duration)
  const seed = hashOf(req.video.fileName)
  const moments = Array.from({ length: count }, (_, i) => {
    const centre = ((i + 0.5) * duration) / count
    const start = clamp(centre - length / 2, 0, Math.max(0, duration - length))
    const pick = FAKE_MOMENTS[(seed + i) % FAKE_MOMENTS.length]
    return {
      start: round2(start),
      peak: round2(clamp(centre, start, start + length)),
      end: round2(start + length),
      title: pick.title,
      reason: pick.reason,
      score: FAKE_SCORES[(seed + i) % FAKE_SCORES.length]
    }
  })
  return { videoEndsAt: duration, moments }
}

/**
 * A second pass ("Ask Gemini again") shows in every clip's reason: the earlier clips and the
 * wish (the last line of the brief) reached the analyzer.
 */
function secondPassNote(req: AnalyzeRequest): string {
  const clips = req.earlierClips
  if (!clips) return ''
  const inReel = clips.filter((clip) => clip.inReel).length
  const wish = req.brief.prompt.trim().split('\n').at(-1) ?? ''
  return ` Second pass: saw ${clips.length} earlier clips (${inReel} in the highlight video), note: “${wish}”`
}

function fakeUsage(durationSec: number, momentCount: number): TokenUsage {
  const promptTokens = Math.round(durationSec * 95) + 1_200
  const outputTokens = 90 * momentCount + 60
  const thoughtsTokens = 400
  return {
    promptTokens,
    outputTokens,
    thoughtsTokens,
    totalTokens: promptTokens + outputTokens + thoughtsTokens
  }
}

function fakeRemoteFile(req: AnalyzeRequest, now: number): RemoteFileRef {
  const id = hashOf(req.video.proxyFingerprint).toString(36)
  return {
    name: `files/fake-${id}`,
    // Gemini-shaped (never fetched): loading a project drops any other name or uri
    uri: `https://generativelanguage.googleapis.com/v1beta/files/fake-${id}`,
    mimeType: 'video/mp4',
    expiresAt: new Date(now + KEEP_MS).toISOString(),
    proxyFingerprint: req.video.proxyFingerprint
  }
}

/** onRemoteFile like the real analyzer: a throwing callback must not break the analysis */
function reportRemoteFile(req: AnalyzeRequest, ref: RemoteFileRef): void {
  try {
    req.onRemoteFile(ref)
  } catch {
    // nothing to log in the fake
  }
}

function canReuse(req: AnalyzeRequest, now: number): boolean {
  const ref = req.remoteFile
  if (!ref || ref.proxyFingerprint !== req.video.proxyFingerprint) return false
  return !ref.expiresAt || Date.parse(ref.expiresAt) - now >= REUSE_MIN_REMAINING_MS
}

export function createFakeAnalyzer(options: FakeAnalyzerOptions = {}): Analyzer {
  const stageMs = options.stageMs ?? DEFAULT_STAGE_MS
  const wait = options.sleep ?? realSleep
  const now = options.now ?? ((): number => Date.now())

  async function analyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
    const { signal } = req
    const name = req.video.fileName
    try {
      throwIfCancelled(signal)
      if (/auth/i.test(name)) {
        req.onStage('uploading', 0)
        throw new AnalyzerError('auth', MESSAGES.auth)
      }
      const reused = canReuse(req, now())
      if (reused) {
        req.onStage('uploading', 1)
      } else {
        for (const [i, progress] of UPLOAD_TICKS.entries()) {
          req.onStage('uploading', progress)
          if (i < UPLOAD_TICKS.length - 1) await wait(stageMs / (UPLOAD_TICKS.length - 1), signal)
        }
      }
      req.onStage('processing', -1)
      await wait(stageMs, signal)
      if (/fail/i.test(name)) {
        throw new AnalyzerError('processing', MESSAGES.fakeProcessing, { retryable: true })
      }
      const kept = reused && req.remoteFile ? req.remoteFile : fakeRemoteFile(req, now())
      reportRemoteFile(req, kept)
      req.onStage('analyzing', -1)
      await wait(stageMs, signal)
      if (/quota/i.test(name)) {
        throw new AnalyzerError('quota', MESSAGES.quotaDay(dailyQuotaAlternative(req.model)))
      }
      if (/safety/i.test(name)) throw new AnalyzerError('safety', MESSAGES.safety)
      const report = normalizeResponse(fakePayload(req), {
        durationSec: req.video.durationSec,
        maxMoments: maxMomentItems(req.video.durationSec)
      })
      return {
        moments: report.moments.map((m) => ({ ...m, reason: m.reason + secondPassNote(req) })),
        model: req.model,
        usage: fakeUsage(req.video.durationSec, report.moments.length),
        remoteFile: kept
      }
    } catch (err) {
      throw toAnalyzerError(err, { signal, model: req.model })
    }
  }

  return {
    analyze,
    listModels: async () => FAKE_MODELS.map((option) => ({ ...option })),
    testKey: async (apiKey) =>
      apiKey.trim()
        ? {
            ok: true,
            message: MESSAGES.keyOk(FAKE_MODELS.length),
            models: FAKE_MODELS.map((option) => ({ ...option }))
          }
        : { ok: false, message: MESSAGES.emptyKey },
    deleteRemoteFile: async () => undefined
  }
}
