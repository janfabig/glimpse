import { readFile, stat, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pathExists } from '../fsx'
import { createAppPaths, type AppPaths } from '../paths'
import { createFakeCipher, type FakeCipher } from '../testing/fakeCipher'
import {
  makeTempDir,
  recordingLogger,
  type RecordingLogger,
  type TempDir
} from '../testing/helpers'
import { SETTINGS_MESSAGES, SettingsStore } from './store'

const KEY = 'AIzaSyD-test-key-0123456789abcdefghijk'
const DEFAULTS = { model: 'gemini-3.8-flash', outputDir: '/Users/jan/Movies/Glimpse' }

let temp: TempDir
let paths: AppPaths
let cipher: FakeCipher
let log: RecordingLogger
let secrets: string[]

beforeEach(async () => {
  temp = await makeTempDir()
  paths = createAppPaths(temp.path)
  cipher = createFakeCipher()
  log = recordingLogger()
  secrets = []
})

afterEach(async () => {
  await temp.cleanup()
})

async function openStore(env: NodeJS.ProcessEnv = {}): Promise<SettingsStore> {
  const store = new SettingsStore({
    paths,
    cipher,
    defaults: DEFAULTS,
    env,
    log,
    onSecret: (s) => secrets.push(s)
  })
  await store.init()
  return store
}

describe('SettingsStore', () => {
  it('starts with defaults and without touching the cipher', async () => {
    const store = await openStore()
    expect(store.getAppSettings()).toEqual({
      model: DEFAULTS.model,
      defaultOutputDir: DEFAULTS.outputDir,
      hasApiKey: false,
      apiKeySource: null,
      fakeAi: false
    })
    expect(await store.getApiKey()).toBeNull()
    expect(cipher.calls).toEqual({ encrypt: 0, decrypt: 0, isAvailable: 0 })
  })

  it('reports HC_FAKE_AI', async () => {
    expect((await openStore({ HC_FAKE_AI: '1' })).getAppSettings().fakeAi).toBe(true)
  })

  it('lets E2E runs require a key while the fake analyzer stays in use', async () => {
    const requireKey = { HC_FAKE_AI: '1', HC_FAKE_AI_REQUIRE_KEY: '1' }
    const e2e = await openStore({ ...requireKey, HC_E2E: '1' })
    // fakeAi false: onboarding, startAnalysis and listModels ask for a key as in real use
    expect(e2e.getAppSettings()).toMatchObject({ fakeAi: false, hasApiKey: false })
    // honoured in E2E runs only
    expect((await openStore(requireKey)).getAppSettings().fakeAi).toBe(true)
  })

  it('persists validated settings', async () => {
    const store = await openStore()
    const next = await store.update({
      model: ' gemini-3.6-flash ',
      defaultOutputDir: '/tmp/out/../reels'
    })
    expect(next).toMatchObject({
      model: 'gemini-3.6-flash',
      defaultOutputDir: '/tmp/reels'
    })
    expect((await openStore()).getAppSettings()).toMatchObject({
      model: 'gemini-3.6-flash',
      defaultOutputDir: '/tmp/reels'
    })
  })

  it('loads a settings.json of the old version: removed options are dropped and not written again', async () => {
    // as written while "Parallel analyses" and "Keep uploads for 48 hours" were settings
    await writeFile(
      paths.settingsFile,
      JSON.stringify({
        model: 'gemini-3.6-flash',
        defaultOutputDir: '/tmp/reels',
        concurrency: 4,
        keepRemoteFiles: false
      })
    )
    const store = await openStore()
    expect(store.getAppSettings()).toEqual({
      model: 'gemini-3.6-flash',
      defaultOutputDir: '/tmp/reels',
      hasApiKey: false,
      apiKeySource: null,
      fakeAi: false
    })
    await store.update({ model: 'gemini-3.8-flash' })
    expect(JSON.parse(await readFile(paths.settingsFile, 'utf8'))).toEqual({
      model: 'gemini-3.8-flash',
      defaultOutputDir: '/tmp/reels'
    })
  })

  it('keeps a stored export folder over the default', async () => {
    // settings.json holds the folder as soon as any setting was changed: the new default
    // (~/Movies/Glimpse) is for installs that stored none
    const stored = '/Users/demo/Movies/Highlights'
    await writeFile(paths.settingsFile, JSON.stringify({ defaultOutputDir: stored }))
    expect((await openStore()).getAppSettings().defaultOutputDir).toBe(stored)
  })

  it('rejects invalid values without changing anything', async () => {
    const store = await openStore()
    for (const patch of [
      { model: '' },
      { model: 'gemini flash' },
      { defaultOutputDir: 'relative' }
    ]) {
      await expect(store.update(patch as never)).rejects.toThrow(/invalid/)
    }
    await expect(store.update(null as never)).rejects.toThrow(/invalid/)
    expect(await pathExists(paths.settingsFile)).toBe(false)
  })

  it('falls back to defaults for a corrupt settings.json', async () => {
    await writeFile(paths.settingsFile, '{ broken')
    expect((await openStore()).getAppSettings().model).toBe(DEFAULTS.model)
  })
})

describe('SettingsStore API key', () => {
  it('stores the key encrypted (base64, mode 0600) and reads it back in a new session', async () => {
    const store = await openStore()
    const next = await store.update({ apiKey: `  ${KEY}  ` })
    expect(next).toMatchObject({ hasApiKey: true, apiKeySource: 'keychain' })
    expect(JSON.stringify(next)).not.toContain(KEY)

    const stored = await readFile(paths.apiKeyFile, 'utf8')
    expect(stored).not.toContain(KEY)
    expect(Buffer.from(stored, 'base64').toString('utf8')).toMatch(/^g1:/)
    expect((await stat(paths.apiKeyFile)).mode & 0o777).toBe(0o600)
    expect(await store.getApiKey()).toBe(KEY)

    const reopened = await openStore()
    expect(reopened.getAppSettings().apiKeySource).toBe('keychain')
    expect(cipher.calls.decrypt).toBe(0)
    expect(await reopened.getApiKey()).toBe(KEY)
    expect(cipher.calls.decrypt).toBe(1)
    await reopened.getApiKey()
    expect(cipher.calls.decrypt).toBe(1)
  })

  it('refuses to store the key when encryption is unavailable – never plaintext', async () => {
    cipher.available = false
    const store = await openStore()
    await expect(store.update({ apiKey: KEY, model: 'gemini-3.6-flash' })).rejects.toThrow(
      SETTINGS_MESSAGES.encryptionUnavailable
    )
    expect(await pathExists(paths.apiKeyFile)).toBe(false)
    expect(store.getAppSettings()).toMatchObject({ hasApiKey: false, model: DEFAULTS.model })
  })

  it('validates the key format', async () => {
    const store = await openStore()
    await expect(store.update({ apiKey: '   ' })).rejects.toThrow(SETTINGS_MESSAGES.emptyKey)
    await expect(store.update({ apiKey: 'AIza with spaces inside' })).rejects.toThrow(/invalid/)
  })

  it('falls back to GEMINI_API_KEY / GOOGLE_API_KEY and prefers the stored key', async () => {
    const envOnly = await openStore({ GOOGLE_API_KEY: 'google-env-key-123' })
    expect(envOnly.getAppSettings()).toMatchObject({ hasApiKey: true, apiKeySource: 'env' })
    expect(await envOnly.getApiKey()).toBe('google-env-key-123')

    const store = await openStore({
      GEMINI_API_KEY: 'gemini-env-key-123',
      GOOGLE_API_KEY: 'google-env-key-123'
    })
    expect(await store.getApiKey()).toBe('gemini-env-key-123')
    await store.update({ apiKey: KEY })
    expect(await store.getApiKey()).toBe(KEY)
    expect(secrets).toContain('gemini-env-key-123')
  })

  it('deletes the key and falls back to the environment', async () => {
    const store = await openStore({ GEMINI_API_KEY: 'gemini-env-key-123' })
    await store.update({ apiKey: KEY })
    const next = await store.update({ apiKey: null })
    expect(next).toMatchObject({ hasApiKey: true, apiKeySource: 'env' })
    expect(await pathExists(paths.apiKeyFile)).toBe(false)
    expect(await store.getApiKey()).toBe('gemini-env-key-123')
    await store.update({ apiKey: null })
  })

  it('re-encrypts when the backend asks for it', async () => {
    await (await openStore()).update({ apiKey: KEY })
    cipher.generation = 2
    const store = await openStore()
    expect(await store.getApiKey()).toBe(KEY)
    expect(
      Buffer.from(await readFile(paths.apiKeyFile, 'utf8'), 'base64').toString('utf8')
    ).toMatch(/^g2:/)
  })

  it('treats an undecryptable key as missing and logs without the key', async () => {
    await (await openStore()).update({ apiKey: KEY })
    cipher.failDecrypt = true
    const store = await openStore()
    expect(store.getAppSettings().apiKeySource).toBe('keychain')
    expect(await store.getApiKey()).toBeNull()
    expect(store.getAppSettings()).toMatchObject({ hasApiKey: false, apiKeySource: null })
    expect(log.entries.some((e) => e.level === 'error')).toBe(true)
    expect(log.text()).not.toContain(KEY)
  })

  it('reports a stored key that cannot be read any more, until a new one is saved', async () => {
    await (await openStore({ GEMINI_API_KEY: 'gemini-env-key-123' })).update({ apiKey: KEY })
    cipher.failDecrypt = true
    const store = await openStore()
    // not known before the first read (reading may ask for Keychain access)
    expect(store.getAppSettings().apiKeyUnreadable).toBeUndefined()
    expect(await store.getApiKey()).toBeNull()
    expect(store.getAppSettings()).toMatchObject({
      hasApiKey: false,
      apiKeySource: null,
      apiKeyUnreadable: true
    })

    // an environment key still works, the unreadable one is reported all the same
    const withEnv = await openStore({ GEMINI_API_KEY: 'gemini-env-key-123' })
    expect(await withEnv.getApiKey()).toBe('gemini-env-key-123')
    expect(withEnv.getAppSettings()).toMatchObject({
      hasApiKey: true,
      apiKeySource: 'env',
      apiKeyUnreadable: true
    })

    cipher.failDecrypt = false
    const saved = await store.update({ apiKey: KEY })
    expect(saved).toMatchObject({ hasApiKey: true, apiKeySource: 'keychain' })
    expect(saved.apiKeyUnreadable).toBeUndefined()
    expect(await store.getApiKey()).toBe(KEY)

    // removing the unreadable key clears the state as well
    cipher.failDecrypt = true
    const again = await openStore()
    await again.getApiKey()
    expect(again.getAppSettings().apiKeyUnreadable).toBe(true)
    expect((await again.update({ apiKey: null })).apiKeyUnreadable).toBeUndefined()
  })

  it('announces keys for log redaction and never logs them', async () => {
    const store = await openStore()
    await store.update({ apiKey: KEY, model: 'gemini-3.6-flash' })
    expect(secrets).toContain(KEY)
    expect(log.text()).not.toContain(KEY)
  })

  it('reports a key in use that Google rejected, until Google accepts it or another key is stored', async () => {
    await (await openStore()).update({ apiKey: KEY })
    const store = await openStore()
    const key = await store.getApiKey()
    expect(key).toBe(KEY)
    // e.g. revoked in AI Studio: an analysis fails with "key rejected"
    store.reportKeyCheck(KEY, false)
    expect(store.getAppSettings()).toMatchObject({
      hasApiKey: true,
      apiKeySource: 'keychain',
      apiKeyRejected: true
    })
    // another key being rejected (a candidate in the key test) changes nothing about this one
    store.reportKeyCheck('AIzaSyD-other-key-000000000000000000', true)
    expect(store.getAppSettings().apiKeyRejected).toBe(true)
    // Google accepts it again (a passed test, a successful analysis)
    store.reportKeyCheck(` ${KEY} `, true)
    expect(store.getAppSettings().apiKeyRejected).toBeUndefined()

    store.reportKeyCheck(KEY, false)
    const replaced = await store.update({ apiKey: 'AIzaSyD-new-key-9876543210zyxwvutsrqp' })
    expect(replaced.apiKeyRejected).toBeUndefined()
    store.reportKeyCheck('AIzaSyD-new-key-9876543210zyxwvutsrqp', false)
    expect(store.getAppSettings().apiKeyRejected).toBe(true)
    expect((await store.update({ apiKey: null })).apiKeyRejected).toBeUndefined()
    // nothing about a key that is not in use, and nothing for the empty key of fake analyses
    store.reportKeyCheck('', false)
    expect(store.getAppSettings().apiKeyRejected).toBeUndefined()
  })

  it('reports a rejected environment key as well', async () => {
    const store = await openStore({ GEMINI_API_KEY: 'gemini-env-key-123' })
    store.reportKeyCheck('gemini-env-key-123', false)
    expect(store.getAppSettings()).toMatchObject({ apiKeySource: 'env', apiKeyRejected: true })
  })
})

describe('SettingsStore concurrent updates', () => {
  const NEW_KEY = 'AIzaSyD-new-key-9876543210zyxwvutsrqp'

  it('applies updates one after the other – a slow key save does not undo later changes', async () => {
    const store = await openStore()
    const prompt = cipher.hold('encrypt')
    const savingKey = store.update({ apiKey: KEY })
    await prompt.reached
    const changingModel = store.update({ model: 'gemini-3.6-flash' })
    const changingDir = store.update({ defaultOutputDir: '/tmp/reels' })
    prompt.release()

    expect(await savingKey).toMatchObject({ hasApiKey: true, model: DEFAULTS.model })
    expect(await changingModel).toMatchObject({ hasApiKey: true, model: 'gemini-3.6-flash' })
    const changed = { model: 'gemini-3.6-flash', defaultOutputDir: '/tmp/reels' }
    expect(await changingDir).toMatchObject(changed)
    expect(JSON.parse(await readFile(paths.settingsFile, 'utf8'))).toEqual(changed)
    expect(await store.getApiKey()).toBe(KEY)
  })

  it('keeps going after a failed update', async () => {
    cipher.available = false
    const store = await openStore()
    const failing = store.update({ apiKey: KEY })
    const next = store.update({ model: 'gemini-3.6-flash' })
    await expect(failing).rejects.toThrow(SETTINGS_MESSAGES.encryptionUnavailable)
    expect((await next).model).toBe('gemini-3.6-flash')
  })

  it('lets a key saved during a pending read win, even when that read is denied', async () => {
    await (await openStore()).update({ apiKey: KEY })
    const store = await openStore()
    const prompt = cipher.hold('decrypt')
    const reading = store.getApiKey()
    await prompt.reached
    expect(await store.update({ apiKey: NEW_KEY })).toMatchObject({ hasApiKey: true })
    cipher.failDecrypt = true
    prompt.release()

    expect(await reading).toBe(NEW_KEY)
    expect(store.getAppSettings()).toMatchObject({ hasApiKey: true, apiKeySource: 'keychain' })
    expect(await store.getApiKey()).toBe(NEW_KEY)
    expect(log.entries.filter((e) => e.level === 'error')).toEqual([])
  })

  it('never re-encrypts an old key over a newer one', async () => {
    await (await openStore()).update({ apiKey: KEY })
    cipher.generation = 2
    const store = await openStore()
    const prompt = cipher.hold('decrypt')
    const reading = store.getApiKey()
    await prompt.reached
    await store.update({ apiKey: NEW_KEY })
    prompt.release()

    expect(await reading).toBe(NEW_KEY)
    expect(await (await openStore()).getApiKey()).toBe(NEW_KEY)
  })

  it('never brings a deleted key back through a pending re-encryption', async () => {
    await (await openStore()).update({ apiKey: KEY })
    cipher.generation = 2
    const store = await openStore()
    const prompt = cipher.hold('decrypt')
    const reading = store.getApiKey()
    await prompt.reached
    await store.update({ apiKey: null })
    prompt.release()

    expect(await reading).toBeNull()
    expect(await pathExists(paths.apiKeyFile)).toBe(false)
    expect(store.getAppSettings()).toMatchObject({ hasApiKey: false, apiKeySource: null })
  })
})
