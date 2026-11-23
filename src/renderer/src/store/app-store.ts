// Global UI state. Main owns the project data; this store mirrors what main sends
// (onProjectUpdated / onExportProgress / onToast) plus purely visual state.

import { create } from 'zustand'
import type {
  AppInfo,
  AppSettings,
  ExportProgress,
  MomentId,
  Project,
  ProjectId,
  ProjectSummary,
  ToastEvent
} from '@shared/types'
import type { StepId } from '../lib/steps'

export type View = { name: 'home' } | { name: 'project'; step: StepId }

export interface ToastItem extends ToastEvent {
  id: number
  action?: { label: string; run: () => void }
  /** the message without the project's name in front (set only when showToast added one) */
  plainMessage?: string
}

/** actions that wait for main; their buttons show a spinner and repeated clicks are ignored */
export type BusyAction = 'createProject' | 'pickVideos' | 'startAnalysis' | 'startExport'

/** key of a video or clip in AppState.pending */
export const itemKey = {
  video: (id: string): string => `video:${id}`,
  moment: (id: string): string => `moment:${id}`
}

export interface ConfirmRequest {
  title: string
  message: string
  confirmLabel: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

export interface AppState {
  phase: 'loading' | 'ready' | 'error'
  bootError: string | null
  settings: AppSettings | null
  appInfo: AppInfo | null
  projects: ProjectSummary[]
  /** the open project (null on the home screen) */
  project: Project | null
  view: View
  settingsOpen: boolean
  exportProgress: Partial<Record<ProjectId, ExportProgress>>
  /** reel signature when the project's last export started – its result is stale once it differs */
  exportBasis: Partial<Record<ProjectId, string>>
  /** files main is reading in right now (probe, fingerprint, poster), per project */
  imports: Partial<Record<ProjectId, string[]>>
  busy: Partial<Record<BusyAction, boolean>>
  /**
   * items (videos, clips) main is changing right now, keyed by itemKey(): they render disabled and
   * ignore further clicks until main answers
   */
  pending: Partial<Record<string, true>>
  /** app-wide confirmation dialog (see confirmDialog()) */
  confirm: ConfirmRequest | null
  toasts: ToastItem[]
  /** per project: the clip and tab the review screen comes back to (kept while the app runs) */
  reviewFocus: Partial<Record<ProjectId, ReviewFocus>>
}

export interface ReviewFocus {
  momentId: MomentId
  tab: 'clips' | 'suggestions'
}

export const useApp = create<AppState>()(() => ({
  phase: 'loading',
  bootError: null,
  settings: null,
  appInfo: null,
  projects: [],
  project: null,
  view: { name: 'home' },
  settingsOpen: false,
  exportProgress: {},
  exportBasis: {},
  imports: {},
  busy: {},
  pending: {},
  confirm: null,
  toasts: [],
  reviewFocus: {}
}))
