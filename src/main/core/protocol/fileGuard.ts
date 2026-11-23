// The window loads the bundled renderer from file://, and Chromium lets a file:// page fetch, show
// and play every other file:// URL – which would bypass the hc-media allow-list. The file:
// protocol therefore serves the renderer bundle only (out/renderer, also inside app.asar).

import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** true for file: URLs of files inside `rendererDir` – nothing else */
export function createRendererFileGuard(rendererDir: string): (url: string) => boolean {
  const root = resolve(rendererDir)
  return (raw) => {
    let path: string
    try {
      const url = new URL(raw)
      if (url.protocol !== 'file:') return false
      // throws for hosts other than "localhost" (e.g. file://server/share)
      path = resolve(fileURLToPath(url))
    } catch {
      return false
    }
    return path.startsWith(root + sep)
  }
}
