// Who may talk to main, where the window may navigate and which links leave the app.

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXTERNAL_HOSTS = new Set(['aistudio.google.com', 'ai.google.dev'])

/** openExternal allow-list: https on Google AI Studio / ai.google.dev only */
export function isAllowedExternalUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    EXTERNAL_HOSTS.has(url.hostname) &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  )
}

export interface AppUrlOptions {
  /** ELECTRON_RENDERER_URL in development */
  devServerUrl?: string
  /** out/renderer/index.html in production */
  indexHtml: string
}

/** true for URLs of our own renderer (dev server origin or the bundled index.html) */
export function createAppUrlMatcher(options: AppUrlOptions): (url: string) => boolean {
  let devOrigin: string | null = null
  if (options.devServerUrl) {
    try {
      devOrigin = new URL(options.devServerUrl).origin
    } catch {
      devOrigin = null
    }
  }
  const indexPath = resolve(options.indexHtml)
  return (raw) => {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return false
    }
    if (devOrigin !== null && url.origin === devOrigin) return true
    if (url.protocol !== 'file:') return false
    try {
      return resolve(fileURLToPath(url)) === indexPath
    } catch {
      return false
    }
  }
}

/** the parts of an IpcMainInvokeEvent the sender check needs */
export interface SenderLike {
  sender: { id: number }
  senderFrame: { url: string; parent: unknown } | null
}

export interface SenderValidatorOptions {
  isAppUrl: (url: string) => boolean
  /** webContents ids of our own windows */
  isOwnWebContents: (id: number) => boolean
}

/** accepts calls from the top-level frame of one of our windows showing our renderer */
export function createSenderValidator(
  options: SenderValidatorOptions
): (event: SenderLike) => boolean {
  return (event) => {
    const frame = event.senderFrame
    if (!frame || frame.parent !== null) return false
    return options.isOwnWebContents(event.sender.id) && options.isAppUrl(frame.url)
  }
}
