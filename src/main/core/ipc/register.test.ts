import { IPC, IPC_HANDED_OVER, parseIpcError } from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import { MediaError } from '../../contracts'
import { CoreError, INTERNAL_ERROR_MESSAGE } from '../errors'
import { recordingLogger } from '../testing/helpers'
import type { IpcHandlers } from './handlers'
import {
  registerHandedOverPaths,
  registerIpcHandlers,
  UNTRUSTED_SENDER_MESSAGE,
  type IpcMainLike
} from './register'
import type { SenderLike } from './security'

type Listener = (event: SenderLike, ...args: unknown[]) => Promise<unknown>

function fakeIpcMain(): IpcMainLike<SenderLike> & { listeners: Map<string, Listener> } {
  const listeners = new Map<string, Listener>()
  return {
    listeners,
    handle: (channel, listener) => void listeners.set(channel, listener)
  }
}

const trusted: SenderLike = { sender: { id: 1 }, senderFrame: { url: 'app://index', parent: null } }
const untrusted: SenderLike = {
  sender: { id: 9 },
  senderFrame: { url: 'https://evil', parent: null }
}

function handlers(
  overrides: Partial<Record<keyof IpcHandlers, (...args: unknown[]) => Promise<unknown>>>
): IpcHandlers {
  const fallback = async (): Promise<never> => {
    throw new Error('not used')
  }
  return Object.fromEntries(
    Object.keys(IPC).map((name) => [name, overrides[name as keyof IpcHandlers] ?? fallback])
  ) as unknown as IpcHandlers
}

async function errorOf(promise: Promise<unknown>): Promise<ReturnType<typeof parseIpcError>> {
  try {
    await promise
  } catch (err) {
    return parseIpcError(err)
  }
  throw new Error('expected a rejection')
}

describe('registerIpcHandlers', () => {
  it('registers one handler per channel', () => {
    const ipcMain = fakeIpcMain()
    registerIpcHandlers(ipcMain, handlers({}), {
      isTrustedSender: () => true,
      log: recordingLogger()
    })
    expect([...ipcMain.listeners.keys()].sort()).toEqual(Object.values(IPC).sort())
  })

  it('passes arguments through for trusted senders only', async () => {
    const ipcMain = fakeIpcMain()
    const log = recordingLogger()
    registerIpcHandlers(ipcMain, handlers({ openProject: async (id) => ({ id }) }), {
      isTrustedSender: (event) => event.sender.id === 1,
      log
    })
    const listener = ipcMain.listeners.get(IPC.openProject) as Listener
    expect(await listener(trusted, 'p1')).toEqual({ id: 'p1' })
    expect(await errorOf(listener(untrusted, 'p1'))).toEqual({
      code: 'invalid',
      message: UNTRUSTED_SENDER_MESSAGE
    })
    expect(log.entries.some((e) => e.level === 'warn')).toBe(true)
  })

  it('encodes expected errors and hides unexpected ones behind a logged internal error', async () => {
    const ipcMain = fakeIpcMain()
    const log = recordingLogger()
    registerIpcHandlers(
      ipcMain,
      handlers({
        startExport: async () => {
          throw new CoreError('nothing-selected', 'Select at least one clip.')
        },
        addVideos: async () => {
          throw new MediaError('no-ffmpeg', 'ffmpeg is missing.')
        },
        listProjects: async () => {
          throw new TypeError('cannot read properties of undefined')
        }
      }),
      { isTrustedSender: () => true, log }
    )
    const call = (name: keyof typeof IPC): Promise<unknown> =>
      (ipcMain.listeners.get(IPC[name]) as Listener)(trusted)
    expect(await errorOf(call('startExport'))).toEqual({
      code: 'nothing-selected',
      message: 'Select at least one clip.'
    })
    expect(await errorOf(call('addVideos'))).toEqual({
      code: 'no-ffmpeg',
      message: 'ffmpeg is missing.'
    })
    expect(await errorOf(call('listProjects'))).toEqual({
      code: 'internal',
      message: INTERNAL_ERROR_MESSAGE
    })
    expect(log.entries.filter((e) => e.level === 'error').map((e) => e.message)).toEqual([
      'listProjects failed'
    ])
    expect(log.text()).toContain('cannot read properties of undefined')
  })
})

describe('registerHandedOverPaths', () => {
  it('records paths the preload reports – from our window only, absolute paths only', () => {
    type MessageListener = (event: SenderLike, ...args: unknown[]) => void
    const listeners = new Map<string, MessageListener>()
    const ipcMain = {
      on: (channel: string, listener: MessageListener) => void listeners.set(channel, listener)
    }
    const handedOver: string[] = []
    const log = recordingLogger()
    registerHandedOverPaths(ipcMain, (path) => handedOver.push(path), {
      isTrustedSender: (event) => event.sender.id === 1,
      log
    })
    const send = listeners.get(IPC_HANDED_OVER) as MessageListener
    send(trusted, '/Users/jan/Movies/Festival')
    send(untrusted, '/Users/jan/Desktop')
    for (const bad of ['relative/folder', '/a\0b', 42, null, `/${'x'.repeat(5000)}`]) {
      send(trusted, bad)
    }
    expect(handedOver).toEqual(['/Users/jan/Movies/Festival'])
    expect(log.entries.some((e) => e.level === 'warn')).toBe(true)
  })
})
