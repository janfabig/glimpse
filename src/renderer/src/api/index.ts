// The renderer talks to main only through `api()`. Outside Electron (browser dev, UI snapshots)
// window.api is missing and an in-memory mock takes its place – only when asked for with ?mock=1
// or in the dev server, never in the packaged app.

import { encodeIpcError, type HighlightApi } from '@shared/ipc'
import type { ExportProgress, MomentId, ProjectId } from '@shared/types'
import type { StepId } from '../lib/steps'
import { parseScenario } from './scenarios'

/** where the UI starts – only the mock provides one (scenario snapshots) */
export interface InitialView {
  projectId?: ProjectId
  step?: StepId
  settingsOpen?: boolean
  exportProgress?: ExportProgress
  activeMomentId?: MomentId
}

export interface ApiSetup {
  api: HighlightApi
  initial: InitialView | null
  mock: boolean
}

const NO_BRIDGE_MESSAGE =
  'The connection to the app is missing (preload not loaded). Restart Glimpse. ' +
  'If that does not help, install the app again.'

let current: HighlightApi | null = null

export function api(): HighlightApi {
  if (!current) throw new Error('API used before initApi() finished')
  return current
}

/** the mock is a development tool; in the real app a missing bridge is an error, not a demo */
export function mockAllowed(search: string, dev: boolean): boolean {
  return dev || new URLSearchParams(search).get('mock') === '1'
}

export async function initApi(): Promise<ApiSetup> {
  if (window.api) {
    current = window.api
    return { api: current, initial: null, mock: false }
  }
  if (!mockAllowed(window.location.search, import.meta.env.DEV)) {
    throw new Error(encodeIpcError({ code: 'internal', message: NO_BRIDGE_MESSAGE }))
  }
  const params = new URLSearchParams(window.location.search)
  const { createMockApi } = await import('./mock')
  const setup = await createMockApi(parseScenario(params.get('scenario')))
  current = setup.api
  return { api: current, initial: setup.initial, mock: true }
}
