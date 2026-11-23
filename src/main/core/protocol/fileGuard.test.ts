import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createRendererFileGuard } from './fileGuard'

describe('createRendererFileGuard', () => {
  const app = '/Applications/Glimpse.app/Contents/Resources/app.asar/out/renderer'
  const allowed = createRendererFileGuard(app)
  const url = (path: string): string => pathToFileURL(path).href

  it('serves the files of the renderer bundle (also inside app.asar)', () => {
    expect(allowed(url(`${app}/index.html`))).toBe(true)
    expect(allowed(url(`${app}/assets/index-abc123.js`))).toBe(true)
    expect(allowed(url(`${app}/assets/montserrat-latin-700-normal.woff2`))).toBe(true)
    expect(allowed(`${url(`${app}/index.html`)}?x=1#top`)).toBe(true)
    expect(
      createRendererFileGuard('/repo/out/renderer/')('file:///repo/out/renderer/index.html')
    ).toBe(true)
  })

  it('refuses every other local file', () => {
    expect(allowed('file:///etc/hosts')).toBe(false)
    expect(allowed(url('/Users/jan/.ssh/id_ed25519'))).toBe(false)
    expect(allowed(url('/Users/jan/Movies/clip.mp4'))).toBe(false)
    // the folder itself, look-alike siblings and escapes
    expect(allowed(url(app))).toBe(false)
    expect(allowed(url(`${app}-evil/index.html`))).toBe(false)
    expect(allowed(`${url(app)}/../main/index.js`)).toBe(false)
    expect(allowed(`${url(app)}/%2e%2e/%2e%2e/package.json`)).toBe(false)
    expect(allowed(url(`${app}/../../../../Info.plist`))).toBe(false)
  })

  it('refuses what is no plain local file URL', () => {
    expect(allowed('file://server/share/index.html')).toBe(false)
    expect(allowed('https://example.com/index.html')).toBe(false)
    expect(allowed('hc-media://local/%2Fetc%2Fhosts')).toBe(false)
    expect(allowed('not a url')).toBe(false)
  })
})
