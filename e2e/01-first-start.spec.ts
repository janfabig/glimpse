// Flow 1 – first start: no key yet, connect Gemini, and the key never shows up in plain text.
// Without a key, nothing is analysed (HC_FAKE_AI_REQUIRE_KEY: the real app's rules, fake Gemini).

import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseIpcError, type HighlightApi, type IpcErrorPayload } from '../src/shared/ipc'
import { expect, test } from './fixtures'
import { dummyApiKey, type HcApp } from './support/app'
import {
  addVideos,
  createProject,
  expectToast,
  projectState,
  screen,
  waitForAnalysis,
  waitForPrepared
} from './support/flows'
import { copyVideo } from './support/media'

/** every file below `dir` (recursively) */
async function filesBelow(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

/** the key must not appear as text, base64 or hex anywhere in the profile */
async function expectKeyNowhere(hc: HcApp, key: string): Promise<void> {
  const needles = [
    Buffer.from(key, 'utf8'),
    Buffer.from(Buffer.from(key, 'utf8').toString('base64'), 'utf8'),
    Buffer.from(Buffer.from(key, 'utf8').toString('hex'), 'utf8')
  ]
  for (const file of await filesBelow(hc.userDataDir)) {
    const content = await readFile(file)
    for (const needle of needles) {
      expect(content.includes(needle), `${file} contains the API key`).toBe(false)
    }
  }
}

test.describe('Flow 1: first start', () => {
  test('home without a key, then a key is tested and saved – never stored or logged in plain text', async ({
    hc
  }) => {
    const { page } = hc
    const key = dummyApiKey()

    // first start: empty home screen, no key
    await expect(screen(page, 'home')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Welcome to Glimpse' })).toBeVisible()
    await expect(page.getByTestId('project-card')).toHaveCount(0)
    expect(await hc.api('getSettings')).toMatchObject({
      hasApiKey: false,
      apiKeySource: null,
      fakeAi: true
    })
    // with HC_FAKE_AI=1 no key is needed, so the onboarding card stays away (see "without a key")
    await expect(page.getByTestId('onboarding')).toHaveCount(0)

    // settings: enter a dummy key, test it, save it
    await page.getByTestId('open-settings').click()
    const modal = page.getByTestId('settings-modal')
    await expect(modal).toBeVisible()
    await expect(modal.getByText('Test mode', { exact: true })).toBeVisible()
    await expect(page.getByTestId('test-api-key')).toBeDisabled()
    await page.getByTestId('api-key-input').fill(key)
    await page.getByTestId('test-api-key').click()
    await expect(page.getByTestId('api-key-result')).toHaveText('Connected: 2 models available')
    await page.getByTestId('save-api-key').click()
    await expect(modal.getByText('Connected', { exact: true })).toBeVisible()
    await expect(page.getByTestId('api-key-input')).toHaveValue('')
    await expect(page.getByTestId('api-key-result')).toHaveText('Connected: 2 models available')

    // the renderer only learns that a key exists
    const settings = await hc.api('getSettings')
    expect(settings).toMatchObject({ hasApiKey: true, apiKeySource: 'keychain' })
    expect(JSON.stringify(settings)).not.toContain(key)

    // the model choice is stored as well
    await page.getByTestId('model-select').selectOption('gemini-3.5-flash-lite')
    await expect(page.getByTestId('model-select')).toHaveValue('gemini-3.5-flash-lite')
    await page.getByTestId('close-settings').click()
    await expect(modal).toHaveCount(0)

    // after a normal quit: encrypted key file, nothing in plain text anywhere in the profile
    await hc.close()
    const keyFile = join(hc.userDataDir, 'gemini-key.bin')
    const info = await stat(keyFile)
    expect(info.size).toBeGreaterThan(0)
    expect(info.mode & 0o777, 'gemini-key.bin is private (0600)').toBe(0o600)
    await expectKeyNowhere(hc, key)
    const log = await hc.mainLog()
    expect(log, 'main.log was written').toContain('settings updated')
    expect(log).not.toContain(key)
    expect(hc.mainOutput()).not.toContain(key)
    const stored = JSON.parse(await readFile(join(hc.userDataDir, 'settings.json'), 'utf8'))
    expect(stored).toMatchObject({ model: 'gemini-3.5-flash-lite' })

    // a restart on the same profile still knows the key (decrypted on demand, never sent over)
    await hc.launch()
    expect(await hc.api('getSettings')).toMatchObject({
      hasApiKey: true,
      apiKeySource: 'keychain',
      model: 'gemini-3.5-flash-lite'
    })
    await hc.page.getByTestId('open-settings').click()
    await hc.page.getByTestId('test-api-key').click()
    await expect(hc.page.getByTestId('api-key-result')).toHaveText('Connected: 2 models available')
    await hc.close()
    await expectKeyNowhere(hc, key)
    expect(await hc.mainLog()).not.toContain(key)
    expect(hc.mainOutput()).not.toContain(key)
  })
})

test.describe('Flow 1: first start without a key', () => {
  // HC_FAKE_AI_REQUIRE_KEY=1: main reports fakeAi=false and asks for a key like the real app,
  // while the fake analyzer stays in use (no network) – the first run looks like the real one
  test.use({ appEnv: { HC_FAKE_AI_REQUIRE_KEY: '1' } })

  test('onboarding card connects Gemini on the start screen', async ({ hc }) => {
    const { page } = hc
    expect(await hc.api('getSettings')).toMatchObject({
      hasApiKey: false,
      apiKeySource: null,
      fakeAi: false
    })
    const key = dummyApiKey()
    const card = page.getByTestId('onboarding')
    await expect(card).toBeVisible()
    await expect(card.getByRole('heading', { name: 'Connect Gemini' })).toBeVisible()
    // what happens with the videos, before the user decides
    await expect(page.getByTestId('onboarding-privacy')).toContainText(
      'For the analysis, a 720p copy of each video goes to Google'
    )
    await expect(page.getByTestId('onboarding-connect')).toBeDisabled()
    await page.getByTestId('onboarding-key-input').fill(key)
    await page.getByTestId('onboarding-connect').click()
    await expectToast(hc, 'Gemini is connected. You can get started.', { level: 'success' })
    await expect(card).toHaveCount(0)
    expect(await hc.api('getSettings')).toMatchObject({ hasApiKey: true, apiKeySource: 'keychain' })

    await hc.close()
    await expectKeyNowhere(hc, key)
    expect(await hc.mainLog()).not.toContain(key)
    expect(hc.mainOutput()).not.toContain(key)
  })

  test('an analysis is refused without a key and starts once Gemini is connected', async ({
    hc,
    videos
  }) => {
    const { page } = hc
    const id = await createProject(hc)
    await addVideos(hc, [videos.portrait.path])
    await waitForPrepared(hc, 1)
    await page.getByTestId('next-step').click()
    await expect(screen(page, 'brief')).toBeVisible()
    await expect(
      page.getByText('Connect Gemini first. For that you need a free API key.')
    ).toBeVisible()

    // "Analyse with Gemini" leads to the settings instead of starting
    await page.getByTestId('start-analysis').click()
    await expectToast(hc, 'Connect Gemini first. Then the analysis can start.', {
      level: 'warning'
    })
    const modal = page.getByTestId('settings-modal')
    await expect(modal).toBeVisible()
    await expect(page.getByTestId('connection-state')).toHaveText('Not connected')

    // main refuses as well, whatever the renderer does
    const refusal = async (call: 'startAnalysis' | 'listModels'): Promise<IpcErrorPayload> => {
      const message = await page.evaluate(
        ([method, projectId]) => {
          const api = (window as unknown as { api: HighlightApi }).api
          const pending =
            method === 'startAnalysis' ? api.startAnalysis(projectId) : api.listModels()
          return pending.then(
            () => 'no error',
            (error: Error) => error.message
          )
        },
        [call, id] as const
      )
      return parseIpcError(new Error(message))
    }
    expect(await refusal('startAnalysis')).toEqual({
      code: 'no-api-key',
      message: 'Connect Gemini first: add your API key in Settings.'
    })
    expect(await refusal('listModels')).toEqual({
      code: 'no-api-key',
      message: 'Add your Gemini API key first.'
    })
    const untouched = await projectState(hc, id)
    expect(untouched.status[untouched.videos[0].id].analysis.stage).toBe('idle')
    expect(untouched.analyses).toEqual({})

    // connect in the open settings: the key is tested first, then stored
    await page.getByTestId('api-key-input').fill(dummyApiKey())
    await page.getByTestId('save-api-key').click()
    await expect(page.getByTestId('connection-state')).toHaveText('Connected')
    await page.getByTestId('close-settings').click()
    await expect(modal).toHaveCount(0)
    await page.getByTestId('start-analysis').click()
    await expect(screen(page, 'analysis')).toBeVisible()
    await waitForAnalysis(hc, { done: 1 })
    expect(Object.keys((await projectState(hc, id)).analyses)).toHaveLength(1)
  })

  test('a key Google rejects during an analysis shows as rejected in the settings', async ({
    hc,
    videos
  }) => {
    const { page } = hc
    // connected first: the key test passes (it was valid when it was stored)
    await page.getByTestId('onboarding-key-input').fill(dummyApiKey())
    await page.getByTestId('onboarding-connect').click()
    await expect(page.getByTestId('onboarding')).toHaveCount(0)

    // then revoked in AI Studio: the fake analyzer rejects the key for files named "auth"
    const revoked = await copyVideo(videos.portrait.path, hc.videoDir, 'Key revoked auth.mp4')
    await createProject(hc)
    await addVideos(hc, [revoked])
    await waitForPrepared(hc, 1)
    await page.getByTestId('next-step').click()
    await page.getByTestId('start-analysis').click()
    await waitForAnalysis(hc, { error: 1 })
    const row = page.locator('[data-testid="analysis-row"][data-stage="error"]')
    await expect(row).toContainText('Google rejected your API key.')

    // "Open Settings" no longer leads to a green "Connected"
    await row.getByTestId('analysis-open-settings').click()
    await expect(page.getByTestId('connection-state')).toHaveText('API key rejected')
    await expect(page.getByTestId('api-key-rejected')).toContainText('Paste a new API key here')
    expect(await hc.api('getSettings')).toMatchObject({ hasApiKey: true, apiKeyRejected: true })
    // the field is ready for the new key
    await expect(page.getByTestId('api-key-input')).toBeFocused()

    // a new key replaces the rejected one
    await page.getByTestId('api-key-input').fill(dummyApiKey())
    await page.getByTestId('save-api-key').click()
    await expect(page.getByTestId('connection-state')).toHaveText('Connected')
    expect((await hc.api('getSettings')).apiKeyRejected).toBeUndefined()
  })

  test('a stored key that cannot be read any more: the settings open with the key field focused', async ({
    hc,
    videos
  }) => {
    // a key file the Keychain (here: the E2E cipher) can no longer decrypt
    await hc.close()
    await writeFile(
      join(hc.userDataDir, 'gemini-key.bin'),
      Buffer.from('y'.repeat(64)).toString('base64')
    )
    await hc.launch()
    const { page } = hc
    await createProject(hc)
    await addVideos(hc, [videos.portrait.path])
    await waitForPrepared(hc, 1)
    await page.getByTestId('next-step').click()

    // main finds out only now: the settings open before the renderer knows the key is unreadable
    await page.getByTestId('start-analysis').click()
    await expectToast(hc, 'Your saved API key can no longer be read.', {
      level: 'warning'
    })
    await expect(page.getByTestId('connection-state')).toHaveText('API key unreadable')
    await expect(page.getByTestId('api-key-input')).toBeFocused()
    // ⌘V and typing land in the field right away
    await page.keyboard.type('AIzaTyped')
    await expect(page.getByTestId('api-key-input')).toHaveValue('AIzaTyped')
  })
})
