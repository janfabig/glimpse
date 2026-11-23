// Model catalog (with its labels), model-list filtering and per-model request limits.
// Facts from docs/research/gemini.md (2026-11-01).
import type { Model } from '@google/genai'
import type { ModelOption } from '@shared/types'

/** model used when the user has not picked one */
export const DEFAULT_MODEL = 'gemini-3.8-flash'

/** curated models in display order (recommended first) */
export const MODEL_CATALOG: readonly ModelOption[] = [
  {
    id: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    description: 'Recommended: fast and accurate, with a free quota',
    recommended: true
  },
  {
    id: 'gemini-4-argon',
    displayName: 'Gemini 4 Argon',
    description: 'Best quality: only with billing turned on, slower and more expensive'
  },
  {
    id: 'gemini-3.6-flash',
    displayName: 'Gemini 3.6 Flash',
    description: 'Solid alternative with a free quota'
  },
  {
    id: 'gemini-3.5-flash-lite',
    displayName: 'Gemini 3.5 Flash-Lite',
    description: 'Low cost: very fast and with a larger daily quota, a little less accurate'
  }
]

const MINUTE = 60_000

/** top-tier models: they think longer and usually have no free quota (Argon, 3.1 Pro preview) */
const PRO_CLASS = /-(?:pro|argon|ultra)(?:-|$)/

/** HTTP timeout of one generateContent call: 20 min for pro-class models, else 10 min. */
export function requestTimeoutMs(model: string): number {
  return PRO_CLASS.test(model) ? 20 * MINUTE : 10 * MINUTE
}

/** Display name of a model id; null when the id is empty */
export function modelLabel(model: string | undefined): string | null {
  if (!model) return null
  return MODEL_CATALOG.find((option) => option.id === model)?.displayName ?? model
}

/** the catalog model with the largest free daily quota (≈ 500 requests vs. ≈ 20 for 3.8 Flash) */
const LARGEST_FREE_QUOTA_MODEL = 'gemini-3.5-flash-lite'

/** Model to suggest when the daily quota of `model` is used up; null when it already is that one. */
export function dailyQuotaAlternative(model: string | undefined): string | null {
  return model === LARGEST_FREE_QUOTA_MODEL ? null : labelOf(LARGEST_FREE_QUOTA_MODEL)
}

/** Free-tier model to suggest when `model` needs billing. */
export function freeTierAlternative(model: string | undefined): string {
  return labelOf(model === DEFAULT_MODEL ? LARGEST_FREE_QUOTA_MODEL : DEFAULT_MODEL)
}

function labelOf(id: string): string {
  return modelLabel(id) ?? id
}

// ---------------------------------------------------------------------------
// models.list() filtering
// ---------------------------------------------------------------------------

/** special-purpose families that cannot analyse a video into text */
const EXCLUDED_PARTS = [
  'tts',
  'image',
  'live',
  'audio',
  'embedding',
  'robotics',
  'computer-use',
  'transcribe',
  'customtools'
]

/** "gemini-3.8-flash" → 3.8; null for ids without a version such as "gemini-flash-latest" */
export function modelVersion(id: string): number | null {
  const match = /^gemini-(\d+(?:\.\d+)?)-/.exec(id)
  return match ? Number(match[1]) : null
}

/**
 * Gemini text/multimodal model usable for the analysis: generation 3 or newer (2.x is restricted to
 * existing users and has no thinkingLevel), no special-purpose family, no "-latest" alias (targets
 * are undocumented – pin explicit ids).
 */
export function isAnalysisModel(id: string): boolean {
  const version = modelVersion(id)
  if (version === null || version < 3 || id.endsWith('-latest')) return false
  return !EXCLUDED_PARTS.some((part) => id.includes(part))
}

/** generation of the default model; see isNewerModel */
const CURRENT_GENERATION = modelVersion(DEFAULT_MODEL) ?? 0

/**
 * Released after the catalog was written: the default's generation or newer. Older models are
 * known and left out on purpose – the legacy gemini-3-flash-preview, the paid-only
 * gemini-3.1-pro-preview and superseded ones such as gemini-3.1-flash-lite.
 */
export function isNewerModel(id: string): boolean {
  const version = modelVersion(id)
  return version !== null && version >= CURRENT_GENERATION
}

/** Description of a model that is not in the catalog */
function extraDescription(id: string): string {
  const preview = /-(?:preview|exp)(?:-|$)/.test(id)
  if (PRO_CLASS.test(id)) {
    return preview
      ? 'New preview model: usually only with billing turned on, behaviour and price may change'
      : 'New top model: usually only with billing turned on'
  }
  return preview
    ? 'New preview model: behaviour and price may change'
    : 'New model from your Gemini account'
}

/** Catalog models the key can use (in catalog order), then newer usable models, newest first. */
export function buildModelOptions(models: readonly Model[]): ModelOption[] {
  const usable = new Map<string, Model>()
  for (const model of models) {
    const id = model.name?.replace(/^models\//, '')
    if (id && model.supportedActions?.includes('generateContent') && isAnalysisModel(id)) {
      usable.set(id, model)
    }
  }
  const catalogIds = new Set(MODEL_CATALOG.map((option) => option.id))
  const known = MODEL_CATALOG.filter((option) => usable.has(option.id)).map((option) => ({
    ...option
  }))
  const newer = [...usable.entries()]
    .filter(([id]) => !catalogIds.has(id) && isNewerModel(id))
    .sort(([a], [b]) => (modelVersion(b) ?? 0) - (modelVersion(a) ?? 0) || a.localeCompare(b))
    .map(([id, model]) => ({
      id,
      displayName: model.displayName?.trim() || id,
      description: extraDescription(id)
    }))
  const options = [...known, ...newer]
  // nothing usable listed (paging problem, unusual project): offer the curated models anyway
  return options.length > 0 ? options : MODEL_CATALOG.map((option) => ({ ...option }))
}
