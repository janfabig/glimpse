// Asks Gemini for the moments of one uploaded video: transport retries per request, plus one more
// request when the answer is unusable (bad JSON, video not seen, no moment, too many broken
// timestamps).
import type { GenerateContentParameters } from '@google/genai'
import type { BriefSettings, TokenUsage } from '@shared/types'
import type { AnalyzeRequest } from '../contracts'
import type { GenAiClient, GenerateResult } from './client'
import { classifyError, ContentProblem, type ContentProblemKind } from './errors'
import type { AnalyzerLogger } from './logger'
import {
  normalizeResponse,
  parseJsonPayload,
  pickBetterReport,
  type NormalizeContext,
  type NormalizeReport,
  type RetryReason
} from './normalize'
import { maxMomentItems } from './prompt'
import {
  addUsage,
  buildGenerateParams,
  responseText,
  SAMPLING_FPS,
  toTokenUsage,
  videoTokenCheck
} from './request'
import { withCallSignal, withRetries, type Sleep } from './retry'
import { formatClock } from './util'

export interface GenerateMomentsInput {
  model: string
  file: { uri: string; mimeType: string }
  video: AnalyzeRequest['video']
  brief: BriefSettings
  earlierClips?: AnalyzeRequest['earlierClips']
  signal?: AbortSignal
}

export interface GenerateDeps {
  sleep: Sleep
  random: () => number
  logger: AnalyzerLogger
  timeZone?: string
}

export interface GeneratedMoments {
  report: NormalizeReport
  /** summed over all billed requests */
  usage: TokenUsage | null
}

type Outcome = { report: NormalizeReport } | { problem: ContentProblem }

export async function generateMoments(
  client: GenAiClient,
  input: GenerateMomentsInput,
  deps: GenerateDeps
): Promise<GeneratedMoments> {
  const duration = input.video.durationSec
  const context: NormalizeContext = {
    durationSec: duration,
    maxMoments: maxMomentItems(duration),
    fps: SAMPLING_FPS
  }
  let usage: TokenUsage | null = null

  const attempt = async (retryHint?: string): Promise<Outcome> => {
    const params = buildGenerateParams({ ...input, retryHint, timeZone: deps.timeZone })
    const response = await requestWithRetries(client, params, input.signal, deps)
    usage = addUsage(usage, toTokenUsage(response.usageMetadata))
    try {
      const text = responseText(response)
      if (videoTokenCheck(response.usageMetadata, duration, SAMPLING_FPS) === 'too-low') {
        throw new ContentProblem('video-not-seen', 'too few VIDEO prompt tokens')
      }
      return { report: normalizeResponse(parseJsonPayload(text), context) }
    } catch (err) {
      if (err instanceof ContentProblem) return { problem: err }
      throw err
    }
  }
  const done = (report: NormalizeReport): GeneratedMoments => {
    deps.logger.info('moments normalised', {
      candidates: report.candidateCount,
      invalid: report.invalidCount,
      overrun: report.overrunCount,
      kept: report.moments.length
    })
    return { report, usage }
  }

  const first = await attempt()
  if ('report' in first && !first.report.retryReason) return done(first.report)
  const reason = 'report' in first ? first.report.retryReason : first.problem.kind
  deps.logger.warn('unusable answer, asking Gemini once more', {
    reason,
    detail: 'problem' in first ? first.problem.message : undefined
  })

  let second: Outcome
  try {
    second = await attempt(retryHint(reason, duration))
  } catch (err) {
    // keep an imperfect but usable first answer rather than failing on the extra request
    if (
      'report' in first &&
      first.report.moments.length > 0 &&
      classifyError(err, input.signal).kind !== 'cancelled'
    ) {
      deps.logger.warn('retry request failed, keeping the first answer', {
        detail: classifyError(err).detail
      })
      return done(first.report)
    }
    throw err
  }
  const report = [first, second].reduce<NormalizeReport | null>(
    (best, outcome) =>
      'report' in outcome ? (best ? pickBetterReport(best, outcome.report) : outcome.report) : best,
    null
  )
  if (report && report.moments.length > 0) return done(report)
  // an empty result here would replace the video's moments and count as a fresh analysis
  throw (
    'problem' in second
      ? second.problem
      : new ContentProblem('format', 'no usable moment in either answer')
  ).toAnalyzerError()
}

function requestWithRetries(
  client: GenAiClient,
  params: GenerateContentParameters,
  signal: AbortSignal | undefined,
  deps: GenerateDeps
): Promise<GenerateResult> {
  return withRetries(
    () =>
      withCallSignal(signal, (callSignal) =>
        client.models.generateContent({
          ...params,
          config: { ...params.config, abortSignal: callSignal }
        })
      ),
    {
      sleep: deps.sleep,
      random: deps.random,
      signal,
      onRetry: (failure, attemptNo, delayMs) =>
        deps.logger.warn('Gemini request failed, retrying', {
          kind: failure.kind,
          detail: failure.detail,
          attempt: attemptNo,
          delayMs
        })
    }
  )
}

/** Extra line for the second request (the system instruction and video stay identical). */
function retryHint(
  reason: RetryReason | ContentProblemKind | null,
  durationSec: number
): string | undefined {
  const end = formatClock(durationSec)
  switch (reason) {
    case 'invalid-candidates':
    case 'ends-at-mismatch':
      return `Note: Your last answer contained invalid timestamps. The video is exactly ${end} long; all timestamps must be in the format MM:SS between 00:00 and ${end}.`
    case 'no-moments':
      return 'Note: Your last answer contained no moment. Name at least one moment; if little fits, the best one with an honestly low score.'
    case 'empty':
    case 'format':
    case 'stopped':
    case 'truncated':
      return 'Note: Your last answer was incomplete or not valid JSON. Answer only with complete JSON following the schema and keep the texts short.'
    default:
      // 'video-not-seen' is an ingestion hiccup: repeat the identical request
      return undefined
  }
}
