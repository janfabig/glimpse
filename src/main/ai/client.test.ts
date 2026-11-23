import { afterEach, expect, it, vi } from 'vitest'
import { createGenAiClient, DEFAULT_BASE_URL } from './client'
import { defaultGeminiDeps } from './gemini'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

// another program on this Mac can set the app's environment (launchctl setenv) – the key must
// still go to Google only. fetch is stubbed: this test never reaches the network.
it('sends requests only to Google, whatever GOOGLE_GEMINI_BASE_URL says', async () => {
  vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'http://127.0.0.1:9')
  const urls: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return Response.json({ models: [] })
  })
  const pager = await createGenAiClient('AIzaFAKE').models.list({ config: { pageSize: 5 } })
  for await (const model of pager) void model
  expect(urls).not.toHaveLength(0)
  expect(urls.filter((url) => !url.startsWith(`${DEFAULT_BASE_URL}/`))).toEqual([])
  expect(defaultGeminiDeps().uploadBaseUrl).toBe(DEFAULT_BASE_URL)
})
