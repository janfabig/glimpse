// Typed bridge between the sandboxed renderer and main (docs/ARCHITECTURE.md §5 "Preload").
// Sandboxed preloads may only require('electron') and, since Electron 45, have no Buffer, events or
// timers – everything else (the shared constants) is bundled by Vite.

import { IPC, IPC_EVENTS, IPC_HANDED_OVER, type HighlightApi, type InvokeMethod } from '@shared/ipc'
import type { ExportProgress, Project, ToastEvent, Unsubscribe } from '@shared/types'
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'

type InvokeApi = Pick<HighlightApi, InvokeMethod>

function invoker<K extends InvokeMethod>(name: K): InvokeApi[K] {
  const channel = IPC[name]
  return ((...args: unknown[]) => ipcRenderer.invoke(channel, ...args)) as InvokeApi[K]
}

function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const invokeApi = Object.fromEntries(
  (Object.keys(IPC) as InvokeMethod[]).map((name) => [name, invoker(name)])
) as InvokeApi

/**
 * Only a real File – from a drop or a file input, i.e. handed over by the user – has a path. Main
 * learns it before the addVideos call that follows (same IPC pipe, in order), so a dropped folder
 * may be listed; folders a renderer script merely names are not.
 */
function getPathForFile(file: File): string {
  const path = webUtils.getPathForFile(file)
  if (path) ipcRenderer.send(IPC_HANDED_OVER, path)
  return path
}

const api: HighlightApi = {
  ...invokeApi,
  getPathForFile,
  onProjectUpdated: (callback) => subscribe<Project>(IPC_EVENTS.projectUpdated, callback),
  onExportProgress: (callback) => subscribe<ExportProgress>(IPC_EVENTS.exportProgress, callback),
  onToast: (callback) => subscribe<ToastEvent>(IPC_EVENTS.toast, callback)
}

contextBridge.exposeInMainWorld('api', api)
