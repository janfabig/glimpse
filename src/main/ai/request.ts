// generateContent request (docs/research/gemini.md) and the checks on its response.
import {
  BlockedReason,
  FinishReason,
  MediaModality,
  MediaProcessing,
  MediaResolution,
  ThinkingLevel,
  type GenerateContentParameters,
  type GenerateContentResponseUsageMetadata
} from '@google/genai'
import type { BriefSettings, TokenUsage } from '@shared/types'
import { AnalyzerError, type AnalyzeRequest } from '../contracts'
import type { GenerateResult } from './client'
import { ContentProblem } from './errors'
import { MESSAGES } from './messages'
import { requestTimeoutMs } from './models'
import { buildResponseSchema, buildUserPrompt, SYSTEM_INSTRUCTION } from './prompt'

/** frames per second Gemini samples from the video (the main cost lever) */
export const SAMPLING_FPS = 1
/** thinking counts against it; too low → MAX_TOKENS and broken JSON */
export const MAX_OUTPUT_TOKENS = 32_768
/** Gemini 3/4 bill 70 tokens per frame at low/medium resolution (280 at high) */
export const TOKENS_PER_FRAME = 70
/** below this share of the expected frame tokens the model has not really seen the video */
export const MIN_VIDEO_TOKEN_SHARE = 0.4

export interface GenerateInput {
  model: string
  file: { uri: string; mimeType: string }
  video: AnalyzeRequest['video']
  brief: BriefSettings
  earlierClips?: AnalyzeRequest['earlierClips']
  retryHint?: string
  timeZone?: string
}

export function buildGenerateParams(input: GenerateInput): GenerateContentParameters {
  return {
    model: input.model,
    contents: [
      {
        role: 'user',
        parts: [
          // video first, text after it; fps and mediaProcessing only apply in static mode
          {
            fileData: { fileUri: input.file.uri, mimeType: input.file.mimeType },
            mediaProcessing: MediaProcessing.STATIC,
            videoMetadata: { fps: SAMPLING_FPS }
          },
          {
            text: buildUserPrompt({
              video: input.video,
              brief: input.brief,
              earlierClips: input.earlierClips,
              retryHint: input.retryHint,
              timeZone: input.timeZone
            })
          }
        ]
      }
    ],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: 'application/json',
      responseJsonSchema: buildResponseSchema(input.video.durationSec),
      // every Gemini 3/4 model accepts MEDIUM (MINIMAL is a 400 on 3.8 Flash and Argon)
      thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      // no request logging/storage on Google's side; no temperature/topP/topK (deprecated)
      store: false,
      httpOptions: { timeout: requestTimeoutMs(input.model) }
    }
  }
}

const SAFETY_FINISH: ReadonlySet<string> = new Set([
  FinishReason.SAFETY,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.BLOCKLIST,
  FinishReason.SPII,
  FinishReason.IMAGE_SAFETY,
  FinishReason.IMAGE_PROHIBITED_CONTENT
])
const OK_FINISH: ReadonlySet<string> = new Set([
  FinishReason.STOP,
  FinishReason.FINISH_REASON_UNSPECIFIED
])

function safetyError(reason: string): AnalyzerError {
  return new AnalyzerError('safety', MESSAGES.safety, {
    cause: new Error(`blocked by Gemini: ${reason}`)
  })
}

/**
 * Text of the first candidate without thought parts. Throws AnalyzerError('safety') for blocked
 * prompts/answers and ContentProblem for answers worth requesting again.
 */
export function responseText(response: GenerateResult): string {
  const blockReason = response.promptFeedback?.blockReason
  if (blockReason && blockReason !== BlockedReason.BLOCKED_REASON_UNSPECIFIED) {
    throw safetyError(blockReason)
  }
  const candidate = response.candidates?.[0]
  if (!candidate) throw new ContentProblem('empty', 'response without candidates')
  // treated as open strings: the REST enum has values the SDK enum lacks
  const finish: string | undefined = candidate.finishReason
  if (finish && SAFETY_FINISH.has(finish)) throw safetyError(finish)
  if (finish === FinishReason.MAX_TOKENS) {
    throw new ContentProblem('truncated', 'finishReason MAX_TOKENS')
  }
  if (finish && !OK_FINISH.has(finish)) {
    throw new ContentProblem('stopped', `finishReason ${finish}`)
  }
  const text = (candidate.content?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
  if (!text.trim()) throw new ContentProblem('empty', 'response without text')
  return text
}

/**
 * Did the model actually receive the frames? Compares the VIDEO (and IMAGE) prompt tokens with
 * duration × fps × 70; 'unknown' when the response carries no usage data.
 */
export function videoTokenCheck(
  usage: GenerateContentResponseUsageMetadata | undefined,
  durationSec: number,
  fps: number
): 'ok' | 'too-low' | 'unknown' {
  if (!usage) return 'unknown'
  const floor = MIN_VIDEO_TOKEN_SHARE * durationSec * fps * TOKENS_PER_FRAME
  const details = [...(usage.promptTokensDetails ?? []), ...(usage.cacheTokensDetails ?? [])]
  if (details.length > 0) {
    const visual = details
      .filter((d) => d.modality === MediaModality.VIDEO || d.modality === MediaModality.IMAGE)
      .reduce((sum, d) => sum + (d.tokenCount ?? 0), 0)
    return visual >= floor ? 'ok' : 'too-low'
  }
  // no per-modality breakdown: the whole prompt must at least be that large
  if (usage.promptTokenCount === undefined) return 'unknown'
  return usage.promptTokenCount >= floor ? 'ok' : 'too-low'
}

export function toTokenUsage(
  usage: GenerateContentResponseUsageMetadata | undefined
): TokenUsage | null {
  if (!usage) return null
  const promptTokens = usage.promptTokenCount ?? 0
  const outputTokens = usage.candidatesTokenCount ?? 0
  const thoughtsTokens = usage.thoughtsTokenCount ?? 0
  return {
    promptTokens,
    outputTokens,
    thoughtsTokens,
    totalTokens: usage.totalTokenCount ?? promptTokens + outputTokens + thoughtsTokens
  }
}

/** usage of several requests for the same analysis (every attempt is billed) */
export function addUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (!a || !b) return a ?? b
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    thoughtsTokens: a.thoughtsTokens + b.thoughtsTokens,
    totalTokens: a.totalTokens + b.totalTokens
  }
}
