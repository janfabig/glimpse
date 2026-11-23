// Validation and normalisation of Gemini's highlight JSON (pure; docs/ARCHITECTURE.md §7).
// Gemini's known failure modes: stamps past the end, malformed stamps ("0:65"), reversed spans,
// overlaps, wrong clip lengths, fenced or chatty JSON, missing fields.
import { LIMITS } from '@shared/presets'
import { formatTimecode, parseTimestamp } from '@shared/time'
import { clamp, isRecord, round2 } from '@shared/util'
import type { AnalyzedMoment } from '../contracts'
import { ContentProblem } from './errors'
import { cleanText, truncate } from './util'

export interface NormalizeContext {
  /** real duration of the analysed video (ffprobe) */
  durationSec: number
  /** keep at most this many moments (the best by score) */
  maxMoments: number
  /**
   * sampling rate of the request: at ≤ 1 fps the stamps are whole seconds, so every end gets a short
   * lead-out (END_PADDING_SEC). Without it the stamps are taken as exact.
   */
  fps?: number
}

export type RetryReason = 'no-moments' | 'invalid-candidates' | 'ends-at-mismatch'

export interface NormalizeReport {
  /** valid, clamped, fitted to the clip length, non-overlapping, sorted by start */
  moments: AnalyzedMoment[]
  candidateCount: number
  /** candidates dropped as unusable: no object, unparseable start/end, starting at/after the end */
  invalidCount: number
  /** candidates with a stamp beyond the end of the video */
  overrunCount: number
  /** the model's own idea of the video length (null when missing or unparseable) */
  videoEndsAt: number | null
  /** set when the answer looks unreliable enough to ask once more */
  retryReason: RetryReason | null
}

/** stamps are whole seconds at 1 fps: up to 1 s past the end is rounding, not an overrun */
export const OVERRUN_TOLERANCE_SEC = 1
export const ENDS_AT_TOLERANCE_SEC = 5
export const MAX_INVALID_SHARE = 0.3
/** where the key instant sits when a clip is cut to length: a bit more room for the reaction */
export const PEAK_POSITION = 0.4
/**
 * Lead-out for whole-second end stamps (≤ 1 fps): a laugh ending at 72.6 s comes back as 01:12, and
 * cutting exactly there clips the end of the laugh, the word or the phrase.
 */
export const END_PADDING_SEC = 0.8
export const DEFAULT_SCORE = 5
const TITLE_MAX = 60
const REASON_MAX = 300
const EPS = 1e-6

// ---------------------------------------------------------------------------
// JSON text
// ---------------------------------------------------------------------------

/** Parses the response text; tolerates a ```json fence and prose around the JSON. */
export function parseJsonPayload(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const body = fenced ? fenced[1] : trimmed
  try {
    return JSON.parse(body)
  } catch {
    // fall through: look for the outermost JSON value inside the text
  }
  const start = body.search(/[{[]/)
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'))
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(body.slice(start, end + 1))
    } catch {
      // reported below
    }
  }
  throw new ContentProblem('format', `response is not valid JSON: ${truncate(trimmed, 120)}`)
}

// ---------------------------------------------------------------------------
// Timestamps and spans
// ---------------------------------------------------------------------------

/**
 * Seconds from a model timestamp ("MM:SS", "M:SS", "H:MM:SS", decimals, "[01:05]", plain seconds or a
 * number); null when unusable. Overflowing fields are read as a total: "0:65" → 65 s. For "M:SS" with
 * SS ≥ 60 the seconds field alone may already be the total ("1:65" → 65 s): that reading wins when it
 * lies inside the video, its minutes match M and the sum lies more than ENDS_AT_TOLERANCE_SEC past the
 * end, otherwise the fields are summed like Google's own normaliser ("1:65" → 125 s; "04:62" → 302 s
 * and "01:62" in a 120 s video → 122 s, overruns at the end, never 62 s).
 */
export function parseStamp(value: unknown, durationSec = Number.POSITIVE_INFINITY): number | null {
  if (typeof value === 'number') return parseTimestamp(value)
  if (typeof value !== 'string') return null
  const text = value
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .trim()
  const strict = parseTimestamp(text)
  if (strict !== null) return strict
  const fields = /^(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)$/.exec(text)
  if (!fields) return null
  const hours: string | undefined = fields[1]
  const seconds = Number(fields[3].replace(',', '.'))
  const summed = Number(hours ?? 0) * 3600 + Number(fields[2]) * 60 + seconds
  const limit = durationSec + OVERRUN_TOLERANCE_SEC
  const minutesMatch = Math.floor(seconds / 60) === Number(fields[2])
  const pastEnd = summed > durationSec + ENDS_AT_TOLERANCE_SEC
  if (hours === undefined && pastEnd && seconds <= limit && minutesMatch) return seconds
  return summed
}

export interface Span {
  start: number
  end: number
}

/**
 * Brings a span to a length within [min, max] around its peak, inside `bounds`. Spans that already
 * fit are returned unchanged; a shorter span is expanded (keeping all of it), a longer one is cut
 * (keeping the peak). The peak ends up at ~40 % of the clip where the bounds allow it.
 */
export function fitAroundPeak(
  span: Span,
  peak: number,
  limits: { min: number; max: number },
  bounds: Span
): Span {
  const length = span.end - span.start
  if (length >= limits.min - EPS && length <= limits.max + EPS) return { ...span }
  const target = clamp(length, limits.min, limits.max)
  if (bounds.end - bounds.start <= target) return { ...bounds }
  const ideal = peak - PEAK_POSITION * target
  const [lo, hi] =
    length < target ? [span.end - target, span.start] : [span.start, span.end - target]
  const start = clamp(clamp(ideal, lo, hi), bounds.start, bounds.end - target)
  return { start, end: start + target }
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

interface Candidate extends Span {
  peak: number
  score: number
  title: string
  reason: string
  /** position in the model's list, for stable ordering */
  index: number
}

interface Limits {
  min: number
  max: number
}

/** the fixed clip length (1 to 30 s); a shorter video lowers the minimum to its own length */
export function clipLimits(durationSec: number): Limits {
  return { min: Math.min(LIMITS.clipSec.min, durationSec), max: LIMITS.clipSec.max }
}

function readScore(value: unknown): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value.replace(',', '.'))
        : Number.NaN
  return Number.isFinite(n) ? clamp(Math.round(n), 1, 10) : DEFAULT_SCORE
}

function readTitle(value: unknown, start: number): string {
  const title = cleanText(value, Number.POSITIVE_INFINITY)
    .replace(/^["'„“”‚‘’»«]+|["'„“”‚‘’»«]+$/g, '')
    .trim()
  return truncate(title, TITLE_MAX) || `Moment at ${formatTimecode(start)}`
}

function readCandidate(
  item: unknown,
  index: number,
  ctx: NormalizeContext
): { candidate: Candidate | null; overrun: boolean } {
  if (!isRecord(item)) return { candidate: null, overrun: false }
  const duration = ctx.durationSec
  let start = parseStamp(item.start, duration)
  let end = parseStamp(item.end, duration)
  const rawPeak = parseStamp(item.peak, duration)
  const overrun = [start, end, rawPeak].some(
    (t) => t !== null && t > duration + OVERRUN_TOLERANCE_SEC
  )
  if (start === null || end === null) return { candidate: null, overrun }
  if (start > end) [start, end] = [end, start]
  if (start >= duration) return { candidate: null, overrun }
  start = Math.max(0, start)
  end = Math.min(duration, end)
  const peak = rawPeak !== null && rawPeak >= start && rawPeak <= end ? rawPeak : (start + end) / 2
  const span = fitAroundPeak({ start, end }, peak, clipLimits(duration), {
    start: 0,
    end: duration
  })
  return {
    candidate: {
      ...span,
      peak,
      score: readScore(item.score),
      title: readTitle(item.title, span.start),
      reason: cleanText(item.reason, REASON_MAX),
      index
    },
    overrun
  }
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end - EPS && b.start < a.end - EPS
}

/**
 * Higher scores win. A weaker moment that overlaps a stronger one is trimmed to the free gap around
 * its peak (and fitted to the clip length again); it is dropped when its peak lies inside the
 * stronger moment or the gap is too short. Returns the kept moments in rank order.
 */
function resolveOverlaps(candidates: Candidate[], ctx: NormalizeContext): Candidate[] {
  const limits = clipLimits(ctx.durationSec)
  const ranked = [...candidates].sort(
    (a, b) => b.score - a.score || a.start - b.start || a.index - b.index
  )
  const kept: Candidate[] = []
  for (const candidate of ranked) {
    const clashes = kept.filter((other) => overlaps(other, candidate))
    if (clashes.length === 0) {
      kept.push(candidate)
      continue
    }
    const peak = candidate.peak
    if (clashes.some((other) => peak >= other.start - EPS && peak <= other.end + EPS)) continue
    let lo = 0
    let hi = ctx.durationSec
    for (const other of kept) {
      if (other.end <= peak + EPS) lo = Math.max(lo, other.end)
      else if (other.start >= peak - EPS) hi = Math.min(hi, other.start)
    }
    if (hi - lo < limits.min - EPS) continue
    const span = { start: Math.max(candidate.start, lo), end: Math.min(candidate.end, hi) }
    kept.push({ ...candidate, ...fitAroundPeak(span, peak, limits, { start: lo, end: hi }) })
  }
  return kept
}

/**
 * End of a kept moment with the lead-out for whole-second stamps (≤ 1 fps), bounded by the video, the
 * next moment and the longest clip length; unchanged at higher sampling rates.
 */
function paddedEnd(moment: Span, next: Span | undefined, ctx: NormalizeContext): number {
  if (ctx.fps === undefined || ctx.fps > 1) return moment.end
  const limit = Math.min(
    ctx.durationSec,
    next?.start ?? Number.POSITIVE_INFINITY,
    moment.start + LIMITS.clipSec.max
  )
  return Math.max(moment.end, Math.min(moment.end + END_PADDING_SEC, limit))
}

function readPayload(payload: unknown): { items: unknown[]; videoEndsAt: unknown } {
  if (Array.isArray(payload)) return { items: payload, videoEndsAt: undefined }
  if (isRecord(payload) && Array.isArray(payload.moments)) {
    return { items: payload.moments, videoEndsAt: payload.videoEndsAt }
  }
  throw new ContentProblem('format', 'response has no "moments" array')
}

/** Turns a parsed response into contract-conform moments plus quality signals for the retry rule. */
export function normalizeResponse(payload: unknown, ctx: NormalizeContext): NormalizeReport {
  const { items, videoEndsAt } = readPayload(payload)
  const duration = ctx.durationSec
  const candidates: Candidate[] = []
  let invalidCount = 0
  let overrunCount = 0
  items.forEach((item, index) => {
    const { candidate, overrun } = readCandidate(item, index, ctx)
    if (overrun) overrunCount++
    if (candidate) candidates.push(candidate)
    else invalidCount++
  })

  const kept = resolveOverlaps(candidates, ctx)
    .slice(0, Math.max(0, ctx.maxMoments))
    .sort((a, b) => a.start - b.start)
  const moments = kept.map((c, i): AnalyzedMoment => ({
    start: round2(c.start),
    end: Math.min(round2(paddedEnd(c, kept[i + 1], ctx)), duration),
    title: c.title,
    reason: c.reason,
    score: c.score
  }))

  const endsAt = parseStamp(videoEndsAt, duration)
  const endsAtMismatch = endsAt === null || Math.abs(endsAt - duration) > ENDS_AT_TOLERANCE_SEC
  // an empty list breaks the schema (minItems 1): taken as a result it would wipe the video's clips
  const retryReason: RetryReason | null =
    items.length === 0
      ? 'no-moments'
      : invalidCount / items.length > MAX_INVALID_SHARE
        ? 'invalid-candidates'
        : overrunCount > 0 && endsAtMismatch
          ? 'ends-at-mismatch'
          : null

  return {
    moments,
    candidateCount: items.length,
    invalidCount,
    overrunCount,
    videoEndsAt: endsAt,
    retryReason
  }
}

/**
 * After a retry: an answer with moments beats one without, then the answer without problems wins,
 * then the one with more moments (ties → newer).
 */
export function pickBetterReport(first: NormalizeReport, second: NormalizeReport): NormalizeReport {
  const found = (report: NormalizeReport): number => (report.moments.length > 0 ? 1 : 0)
  const clean = (report: NormalizeReport): number => (report.retryReason ? 0 : 1)
  if (found(first) !== found(second)) return found(second) > found(first) ? second : first
  if (clean(first) !== clean(second)) return clean(second) > clean(first) ? second : first
  return second.moments.length >= first.moments.length ? second : first
}
