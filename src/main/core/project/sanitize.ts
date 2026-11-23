// Field validation for BriefSettings and ExportSettings, shared by the mutations (strict: invalid
// values are rejected) and by loading project files (lenient: invalid values keep the base value).

import { LIMITS } from '@shared/presets'
import type {
  AspectRatio,
  BriefSettings,
  ExportSettings,
  FitMode,
  TransitionType
} from '@shared/types'
import { clamp, isRecord } from '@shared/util'
import { isAbsolute, normalize } from 'node:path'
import { fail } from '../errors'

export type MergeMode = 'strict' | 'lenient'

const ASPECTS: readonly AspectRatio[] = ['source', '9:16', '4:5', '1:1', '16:9']
const FIT_MODES: readonly FitMode[] = ['crop', 'blur']
const TRANSITIONS: readonly TransitionType[] = ['cut', 'crossfade']

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

type Parser<T> = (value: unknown) => T | undefined

interface Field<T> {
  /** label used in error messages */
  label: string
  parse: Parser<T>
}

function oneOf<T extends string>(values: readonly T[]): Parser<T> {
  return (value) => (values.includes(value as T) ? (value as T) : undefined)
}

const BRIEF_FIELDS: { [K in keyof BriefSettings]: Field<BriefSettings[K]> } = {
  prompt: {
    label: 'Your prompt',
    parse: (value) => (typeof value === 'string' ? value.slice(0, LIMITS.promptMax) : undefined)
  },
  targetDurationSec: {
    label: 'Target length',
    parse: (value) => {
      if (value === null) return null
      const { min, max } = LIMITS.targetDurationSec
      return isFiniteNumber(value) ? Math.round(clamp(value, min, max)) : undefined
    }
  }
}

const EXPORT_FIELDS: { [K in keyof ExportSettings]: Field<ExportSettings[K]> } = {
  aspect: { label: 'Format', parse: oneOf(ASPECTS) },
  fit: { label: 'Fit', parse: oneOf(FIT_MODES) },
  transition: { label: 'Transition', parse: oneOf(TRANSITIONS) },
  outputDir: {
    label: 'Export folder',
    parse: (value) => {
      if (value === null || value === '') return null
      if (typeof value !== 'string' || value.length > 1024 || value.includes('\0')) return undefined
      return isAbsolute(value) ? normalize(value) : undefined
    }
  }
}

function mergeFields<T extends object>(
  fields: { [K in keyof T]: Field<T[K]> },
  base: T,
  patch: unknown,
  mode: MergeMode
): T {
  const merged = { ...base }
  if (!isRecord(patch)) {
    if (mode === 'strict') fail('invalid', 'Invalid settings.')
    return merged
  }
  for (const key of Object.keys(fields) as (keyof T)[]) {
    if (!Object.hasOwn(patch, key) || patch[key as string] === undefined) continue
    const field = fields[key]
    const parsed = field.parse(patch[key as string])
    if (parsed === undefined) {
      if (mode === 'strict') fail('invalid', `Invalid value for “${field.label}”.`)
      continue
    }
    merged[key] = parsed
  }
  return merged
}

/** Applies a (partial) brief; clamps the target length to LIMITS. Unknown fields are ignored. */
export function mergeBrief(base: BriefSettings, patch: unknown, mode: MergeMode): BriefSettings {
  return mergeFields(BRIEF_FIELDS, base, patch, mode)
}

export function mergeExportSettings(
  base: ExportSettings,
  patch: unknown,
  mode: MergeMode
): ExportSettings {
  return mergeFields(EXPORT_FIELDS, base, patch, mode)
}
