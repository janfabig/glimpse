// ipcMain.handle() for every invoke channel: sender check, then the handler; every error leaves as
// an encoded IPC error (unexpected ones are logged and become `internal`).

import { encodeIpcError, IPC, IPC_HANDED_OVER, type InvokeMethod } from '@shared/ipc'
import { isAbsolute } from 'node:path'
import { toIpcPayload } from '../errors'
import type { Logger } from '../log'
import type { IpcHandlers } from './handlers'
import type { SenderLike } from './security'

/** the subset of Electron's ipcMain used here (keeps this module testable) */
export interface IpcMainLike<E extends SenderLike> {
  handle(channel: string, listener: (event: E, ...args: unknown[]) => Promise<unknown>): void
}

/** the one-way part of Electron's ipcMain (ipcRenderer.send) */
export interface IpcMainMessagesLike<E extends SenderLike> {
  on(channel: string, listener: (event: E, ...args: unknown[]) => void): void
}

/**
 * The preload reports every path the user handed over by a drop (IPC_HANDED_OVER); `handOver`
 * records it (JobManager.grantPaths). Untrusted senders and malformed paths are ignored.
 */
export function registerHandedOverPaths<E extends SenderLike>(
  ipcMain: IpcMainMessagesLike<E>,
  handOver: (path: string) => void,
  options: { isTrustedSender: (event: E) => boolean; log: Logger }
): void {
  ipcMain.on(IPC_HANDED_OVER, (event, path) => {
    if (!options.isTrustedSender(event)) {
      options.log.warn('ipc', 'message from an untrusted sender ignored', {
        channel: IPC_HANDED_OVER,
        url: event.senderFrame?.url
      })
      return
    }
    const valid =
      typeof path === 'string' && path.length <= 4096 && !path.includes('\0') && isAbsolute(path)
    if (valid) handOver(path)
  })
}

export const UNTRUSTED_SENDER_MESSAGE = 'This request was blocked for security reasons.'

export function registerIpcHandlers<E extends SenderLike>(
  ipcMain: IpcMainLike<E>,
  handlers: IpcHandlers,
  options: { isTrustedSender: (event: E) => boolean; log: Logger }
): void {
  const { log } = options
  for (const name of Object.keys(IPC) as InvokeMethod[]) {
    const channel = IPC[name]
    ipcMain.handle(channel, async (event, ...args) => {
      if (!options.isTrustedSender(event)) {
        log.warn('ipc', 'call from an untrusted sender rejected', {
          channel,
          url: event.senderFrame?.url
        })
        throw new Error(encodeIpcError({ code: 'invalid', message: UNTRUSTED_SENDER_MESSAGE }))
      }
      try {
        return await handlers[name](...args)
      } catch (err) {
        const { payload, expected } = toIpcPayload(err)
        if (expected) {
          log.info('ipc', `${name} rejected`, { code: payload.code, message: payload.message })
        } else {
          log.error('ipc', `${name} failed`, { err })
        }
        throw new Error(encodeIpcError(payload), { cause: err })
      }
    })
  }
}
