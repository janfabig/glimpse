// Argument validation for IPC calls. Anything the renderer sends is untrusted.

import type { StartAnalysisOptions } from '@shared/ipc'
import { LIMITS } from '@shared/presets'
import type { ProjectMutation, SettingsPatch } from '@shared/types'
import { isRecord } from '@shared/util'
import { isAbsolute, normalize } from 'node:path'
import { fail } from '../errors'
import { isValidId } from '../ids'

export const INVALID_REQUEST = 'Invalid request.'

const MAX_PATH_LENGTH = 4096
const MAX_PATHS = 500
const MAX_NAME_LENGTH = 80

function invalid(what: string): never {
  fail('invalid', `${INVALID_REQUEST} (${what})`)
}

export function idArg(value: unknown, what: string): string {
  if (!isValidId(value)) invalid(what)
  return value
}

export const projectIdArg = (value: unknown): string => idArg(value, 'project')
export const videoIdArg = (value: unknown): string => idArg(value, 'video')

function isPathString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    !value.includes('\0')
  )
}

export function absolutePathArg(value: unknown, what = 'path'): string {
  if (!isPathString(value) || !isAbsolute(value)) invalid(what)
  return normalize(value)
}

/** file paths for import – relative ones are reported back as skipped, not rejected */
export function pathListArg(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_PATHS || !value.every(isPathString)) {
    invalid('files')
  }
  return value
}

/** optional project name; blank means "use the default" */
export function optionalNameArg(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') invalid('name')
  const name = value.trim()
  return name === '' ? undefined : [...name].slice(0, MAX_NAME_LENGTH).join('')
}

export function optionalApiKeyArg(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length > 512) invalid('API key')
  return value.trim()
}

export function startAnalysisOptionsArg(value: unknown): StartAnalysisOptions | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) invalid('analysis')
  const options: StartAnalysisOptions = {}
  if (value.videoIds !== undefined) {
    if (!Array.isArray(value.videoIds) || value.videoIds.length > MAX_PATHS) invalid('videos')
    options.videoIds = value.videoIds.map(videoIdArg)
  }
  if (value.force !== undefined) {
    if (typeof value.force !== 'boolean') invalid('analysis')
    options.force = value.force
  }
  return options
}

/** "Ask Gemini again": text, trimmed, at most as long as the longest prompt */
export function wishArg(value: unknown): string {
  const wish = typeof value === 'string' ? value.trim() : ''
  if (!wish || wish.length > LIMITS.promptMax) invalid('note')
  return wish
}

/** only the envelope; the values are validated by the SettingsStore */
export function settingsPatchArg(value: unknown): SettingsPatch {
  if (!isRecord(value)) invalid('settings')
  const patch: SettingsPatch = {}
  for (const key of ['model', 'apiKey', 'defaultOutputDir'] as const) {
    if (Object.hasOwn(value, key) && value[key] !== undefined) {
      ;(patch as Record<string, unknown>)[key] = value[key]
    }
  }
  return patch
}

/** only the envelope; the fields are validated by applyMutation() */
export function mutationArg(value: unknown): ProjectMutation {
  if (!isRecord(value) || typeof value.type !== 'string' || value.type.length > 40) {
    invalid('change')
  }
  return value as unknown as ProjectMutation
}

export function urlArg(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) invalid('link')
  return value
}
