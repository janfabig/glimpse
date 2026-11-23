import type { HighlightApi } from '@shared/ipc'

declare global {
  interface Window {
    /** undefined when the renderer runs outside Electron (browser dev / UI snapshots → mock API) */
    api?: HighlightApi
  }
}
