import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createAppUrlMatcher, createSenderValidator, isAllowedExternalUrl } from './security'

describe('isAllowedExternalUrl', () => {
  it('allows https links to AI Studio and ai.google.dev', () => {
    expect(isAllowedExternalUrl('https://aistudio.google.com/apikey')).toBe(true)
    expect(isAllowedExternalUrl('https://ai.google.dev/gemini-api/docs/pricing?hl=de#x')).toBe(true)
  })

  it('rejects everything else', () => {
    for (const url of [
      'http://aistudio.google.com/apikey',
      'https://aistudio.google.com.evil.com/',
      'https://evil.com/?https://aistudio.google.com',
      'https://user:pw@aistudio.google.com/',
      'https://aistudio.google.com:8443/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url'
    ]) {
      expect(isAllowedExternalUrl(url), url).toBe(false)
    }
  })
})

describe('createAppUrlMatcher', () => {
  const indexHtml = '/Applications/Glimpse.app/Contents/Resources/app/out/renderer/index.html'

  it('accepts the bundled index.html with query and hash', () => {
    const matches = createAppUrlMatcher({ indexHtml })
    const url = pathToFileURL(indexHtml).href
    expect(matches(url)).toBe(true)
    expect(matches(`${url}?mock=1#/review`)).toBe(true)
    expect(matches(pathToFileURL('/etc/passwd').href)).toBe(false)
    expect(matches('http://localhost:5173/')).toBe(false)
  })

  it('accepts the dev server origin only in development', () => {
    const matches = createAppUrlMatcher({ indexHtml, devServerUrl: 'http://localhost:5173' })
    expect(matches('http://localhost:5173/src/main.tsx')).toBe(true)
    expect(matches('http://localhost:5174/')).toBe(false)
    expect(matches('https://example.com/')).toBe(false)
  })
})

describe('createSenderValidator', () => {
  const validate = createSenderValidator({
    isAppUrl: (url) => url === 'file:///app/index.html',
    isOwnWebContents: (id) => id === 1
  })

  it('accepts the top-level frame of our window', () => {
    expect(
      validate({ sender: { id: 1 }, senderFrame: { url: 'file:///app/index.html', parent: null } })
    ).toBe(true)
  })

  it('rejects other windows, sub-frames, foreign pages and destroyed frames', () => {
    expect(
      validate({ sender: { id: 2 }, senderFrame: { url: 'file:///app/index.html', parent: null } })
    ).toBe(false)
    expect(
      validate({ sender: { id: 1 }, senderFrame: { url: 'file:///app/index.html', parent: {} } })
    ).toBe(false)
    expect(
      validate({ sender: { id: 1 }, senderFrame: { url: 'https://evil.com/', parent: null } })
    ).toBe(false)
    expect(validate({ sender: { id: 1 }, senderFrame: null })).toBe(false)
  })
})
