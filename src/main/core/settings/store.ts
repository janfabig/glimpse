// App settings (settings.json) and the Gemini API key (encrypted in gemini-key.bin, never plaintext).
// The key stays in the main process: the renderer only learns hasApiKey / apiKeySource.

import type { AppSettings, SettingsPatch } from '@shared/types'
import { isRecord } from '@shared/util'
import { readFile, unlink } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import { fail } from '../errors'
import { pathExists, writeFileAtomic } from '../fsx'
import type { Logger } from '../log'
import type { AppPaths } from '../paths'
import type { SecretCipher } from './cipher'

interface StoredSettings {
  model: string
  defaultOutputDir: string
}

export interface SettingsStoreOptions {
  paths: Pick<AppPaths, 'settingsFile' | 'apiKeyFile'>
  cipher: SecretCipher
  defaults: { model: string; outputDir: string }
  /** GEMINI_API_KEY / GOOGLE_API_KEY fallback and HC_FAKE_AI */
  env: NodeJS.ProcessEnv
  log: Logger
  /** called with every API key that becomes known, so logging can redact it */
  onSecret?: (secret: string) => void
}

export const SETTINGS_MESSAGES = {
  invalid: 'Invalid settings.',
  model: 'Invalid model name.',
  outputDir: 'The folder must be an absolute path.',
  emptyKey: 'Enter an API key.',
  malformedKey: 'The API key looks invalid. Copy it again in full.',
  encryptionUnavailable: 'The macOS Keychain is not available. The API key was not saved.',
  keySaveFailed: 'The API key could not be saved.'
} as const

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,99}$/
const KEY_PATTERN = /^[\x21-\x7e]{8,256}$/

function parseModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const model = value.trim()
  return MODEL_PATTERN.test(model) ? model : undefined
}

function parseDir(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 1024 || value.includes('\0')) return undefined
  return isAbsolute(value) ? normalize(value) : undefined
}

/** undefined: keep the key, null: delete it, string: store it */
function parseKeyChange(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value
  if (typeof value !== 'string' || value.trim() === '') fail('invalid', SETTINGS_MESSAGES.emptyKey)
  const key = value.trim()
  if (!KEY_PATTERN.test(key)) fail('invalid', SETTINGS_MESSAGES.malformedKey)
  return key
}

/** validates the whole patch; only the fields it sets end up in `settings` */
function parsePatch(patch: SettingsPatch): {
  settings: Partial<StoredSettings>
  key: string | null | undefined
} {
  if (!isRecord(patch)) fail('invalid', SETTINGS_MESSAGES.invalid)
  const settings: Partial<StoredSettings> = {}
  if (patch.model !== undefined) {
    settings.model = parseModel(patch.model) ?? fail('invalid', SETTINGS_MESSAGES.model)
  }
  if (patch.defaultOutputDir !== undefined) {
    settings.defaultOutputDir =
      parseDir(patch.defaultOutputDir) ?? fail('invalid', SETTINGS_MESSAGES.outputDir)
  }
  return { settings, key: parseKeyChange(patch.apiKey) }
}

export class SettingsStore {
  private readonly options: SettingsStoreOptions
  private settings: StoredSettings
  private keyStored = false
  /** the stored key exists but could not be decrypted (Keychain denied, other machine …) */
  private keyUnreadable = false
  private keyPromise: Promise<string | null> | null = null
  /** the stored key once it was read or stored in this session (to compare with rejected keys) */
  private knownKey: string | null = null
  /** keys Google rejected in this session (an analysis or a key test); see apiKeyRejected */
  private readonly rejectedKeys = new Set<string>()
  /** bumped whenever the key is stored or deleted: a read of an older key must not change state */
  private keyGeneration = 0
  /** writes of settings.json and gemini-key.bin, one after the other */
  private writes: Promise<unknown> = Promise.resolve()

  constructor(options: SettingsStoreOptions) {
    this.options = options
    this.settings = this.defaults()
    const envKey = this.envKey()
    if (envKey) options.onSecret?.(envKey)
  }

  private defaults(): StoredSettings {
    return {
      model: this.options.defaults.model,
      defaultOutputDir: this.options.defaults.outputDir
    }
  }

  async init(): Promise<void> {
    const raw = await this.readSettingsFile()
    const defaults = this.defaults()
    // only these two: what an older version stored besides them is dropped
    this.settings = {
      model: parseModel(raw.model) ?? defaults.model,
      defaultOutputDir: parseDir(raw.defaultOutputDir) ?? defaults.defaultOutputDir
    }
    // existence only – decrypting may prompt for Keychain access, so it waits until the key is needed
    this.keyStored = await pathExists(this.options.paths.apiKeyFile)
  }

  private async readSettingsFile(): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.options.paths.settingsFile, 'utf8'))
      return isRecord(parsed) ? parsed : {}
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.options.log.warn('settings', 'settings.json unreadable – using defaults', { err })
      }
      return {}
    }
  }

  /**
   * HC_FAKE_AI=1: no key needed. E2E runs can add HC_FAKE_AI_REQUIRE_KEY=1 to test the first start:
   * the fake analyzer stays in use, but the app asks for a key as in real use.
   */
  get fakeAi(): boolean {
    const { HC_FAKE_AI, HC_E2E, HC_FAKE_AI_REQUIRE_KEY } = this.options.env
    const requireKey = HC_E2E === '1' && HC_FAKE_AI_REQUIRE_KEY === '1'
    return HC_FAKE_AI === '1' && !requireKey
  }

  private envKey(): string | null {
    const { GEMINI_API_KEY, GOOGLE_API_KEY } = this.options.env
    return GEMINI_API_KEY?.trim() || GOOGLE_API_KEY?.trim() || null
  }

  private apiKeySource(): AppSettings['apiKeySource'] {
    if (this.keyStored && !this.keyUnreadable) return 'keychain'
    return this.envKey() ? 'env' : null
  }

  getAppSettings(): AppSettings {
    const source = this.apiKeySource()
    // the key in use, as far as it is known without asking the Keychain
    const key = source === 'keychain' ? this.knownKey : source === 'env' ? this.envKey() : null
    return {
      ...this.settings,
      hasApiKey: source !== null,
      apiKeySource: source,
      // known once a read failed; storing or deleting a key clears it
      ...(this.keyStored && this.keyUnreadable ? { apiKeyUnreadable: true } : {}),
      ...(key !== null && this.rejectedKeys.has(key) ? { apiKeyRejected: true } : {}),
      fakeAi: this.fakeAi
    }
  }

  /**
   * Google's verdict about a key (an analysis, a key test). A rejected key in use shows as
   * apiKeyRejected until Google accepts it again or another key is stored or the key is removed.
   */
  reportKeyCheck(apiKey: string, accepted: boolean): void {
    const key = apiKey.trim()
    if (!key) return
    if (accepted) {
      this.rejectedKeys.delete(key)
      return
    }
    // a handful per session at most; never let the set grow without bounds
    if (this.rejectedKeys.size >= 16) this.rejectedKeys.clear()
    this.rejectedKeys.add(key)
  }

  /** the stored key, else the environment key, else null */
  async getApiKey(): Promise<string | null> {
    for (;;) {
      if (!this.keyStored || this.keyUnreadable) return this.envKey()
      const generation = this.keyGeneration
      this.keyPromise ??= this.readStoredKey(generation)
      const key = await this.keyPromise
      // a key stored or deleted during the read wins: answer for the current one
      if (generation === this.keyGeneration) return key ?? this.envKey()
    }
  }

  private async readStoredKey(generation: number): Promise<string | null> {
    try {
      const encoded = (await readFile(this.options.paths.apiKeyFile, 'utf8')).trim()
      const { result, shouldReEncrypt } = await this.options.cipher.decrypt(
        Buffer.from(encoded, 'base64')
      )
      if (!result) throw new Error('decrypted key is empty')
      this.options.onSecret?.(result)
      if (generation === this.keyGeneration) this.knownKey = result
      if (shouldReEncrypt) await this.reEncrypt(result, generation)
      return result
    } catch (err) {
      if (generation !== this.keyGeneration) return null
      this.options.log.error('settings', 'stored API key could not be decrypted', {
        err: err instanceof Error ? err.message : String(err)
      })
      this.keyUnreadable = true
      this.keyPromise = null
      return null
    }
  }

  /** the backend rotated its key: store a fresh encryption, unless the key changed meanwhile */
  private reEncrypt(key: string, generation: number): Promise<void> {
    return this.serialize(async () => {
      if (generation === this.keyGeneration) await this.writeKey(key)
    }).catch((err: unknown) =>
      this.options.log.warn('settings', 're-encrypting the API key failed', { err })
    )
  }

  /** runs `task` once every earlier write has finished */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writes.then(task)
    this.writes = result.catch(() => undefined)
    return result
  }

  private async writeKey(key: string): Promise<void> {
    const encrypted = await this.options.cipher.encrypt(key)
    await writeFileAtomic(this.options.paths.apiKeyFile, encrypted.toString('base64'), {
      mode: 0o600
    })
  }

  private replaceKeyState(stored: boolean, key: string | null): void {
    this.keyGeneration++
    this.keyStored = stored
    this.keyUnreadable = false
    this.keyPromise = key === null ? null : Promise.resolve(key)
    this.knownKey = key
    // a new key or none: Google's earlier verdicts no longer describe what is in use
    this.rejectedKeys.clear()
  }

  private async storeKey(key: string): Promise<void> {
    this.options.onSecret?.(key)
    if (!(await this.options.cipher.isAvailable())) {
      fail('internal', SETTINGS_MESSAGES.encryptionUnavailable)
    }
    try {
      await this.writeKey(key)
    } catch (err) {
      this.options.log.error('settings', 'storing the API key failed', {
        err: err instanceof Error ? err.message : String(err)
      })
      fail('internal', SETTINGS_MESSAGES.keySaveFailed)
    }
    this.replaceKeyState(true, key)
  }

  private async deleteKey(): Promise<void> {
    await unlink(this.options.paths.apiKeyFile).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err
    })
    this.replaceKeyState(false, null)
  }

  /**
   * Validates the whole patch first. Then, after every earlier update has finished, stores the key
   * and writes settings.json – so concurrent updates (one control each) never undo each other.
   */
  async update(patch: SettingsPatch): Promise<AppSettings> {
    const change = parsePatch(patch)
    return this.serialize(async () => {
      if (change.key === null) await this.deleteKey()
      else if (change.key !== undefined) await this.storeKey(change.key)

      const next = { ...this.settings, ...change.settings }
      if (JSON.stringify(next) !== JSON.stringify(this.settings)) {
        await writeFileAtomic(this.options.paths.settingsFile, JSON.stringify(next, null, 2) + '\n')
        this.settings = next
      }
      this.options.log.info('settings', 'settings updated', {
        fields: Object.keys(change.settings),
        keyChange: change.key === undefined ? 'none' : change.key === null ? 'deleted' : 'stored'
      })
      return this.getAppSettings()
    })
  }
}
