// Electron wiring of the hc-media: scheme and of the file: guard (thin – the logic lives in
// mediaHandler.ts and fileGuard.ts).

import { MEDIA_SCHEME } from '@shared/media-url'
import { net, protocol } from 'electron'
import type { Logger } from '../log'
import { createRendererFileGuard } from './fileGuard'
import { handleMediaRequest, type MediaAllowList } from './mediaHandler'

/** must run before the app is ready */
export function registerMediaSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true }
    }
  ])
}

export function installMediaProtocol(isAllowed: MediaAllowList, log: Logger): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const response = await handleMediaRequest(request, isAllowed)
      if (response.status === 403) {
        log.warn('media-protocol', 'blocked request', { url: request.url })
      }
      return response
    } catch (err) {
      log.error('media-protocol', 'request failed', { url: request.url, err })
      return new Response(null, { status: 500 })
    }
  })
}

/**
 * file: serves the renderer bundle only (works in out/renderer and inside app.asar); everything
 * else answers 403. Media reach the renderer through hc-media: and its allow-list.
 */
export function installRendererFileProtocol(rendererDir: string, log: Logger): void {
  const isRendererFile = createRendererFileGuard(rendererDir)
  protocol.handle('file', (request) => {
    if (!isRendererFile(request.url)) {
      log.warn('file-protocol', 'blocked request', { url: request.url })
      return new Response(null, { status: 403 })
    }
    return net.fetch(request, { bypassCustomProtocolHandlers: true })
  })
}
