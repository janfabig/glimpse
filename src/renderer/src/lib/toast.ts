// How long a toast stays: long enough to read it. Main marks the toasts nobody may miss as sticky
// (failures at the end of an analysis run or an export, unsaved changes, a restored project): they
// stay until the user closes them – the analysis of a festival takes a while and nobody watches it
// the whole time.

import type { ToastEvent } from '@shared/types'

type Level = ToastEvent['level']

const MIN_MS: Record<Level, number> = { info: 4_500, success: 4_500, warning: 7_000, error: 9_000 }
const MAX_MS: Record<Level, number> = {
  info: 10_000,
  success: 10_000,
  warning: 20_000,
  error: 25_000
}
/** a moment to notice the toast, then a calm reading pace (~16 characters per second) */
const NOTICE_MS = 1_500
const MS_PER_CHAR = 60
/** time to reach a button in the toast (e.g. "Undo") */
const ACTION_MS = 3_000

/** milliseconds until the toast closes by itself; null = it stays until the user closes it */
export function toastDuration(
  level: Level,
  message: string,
  withAction = false,
  sticky = false
): number | null {
  if (sticky) return null
  const reading = NOTICE_MS + MS_PER_CHAR * message.length
  const ms = Math.min(MAX_MS[level], Math.max(MIN_MS[level], reading))
  return withAction ? ms + ACTION_MS : ms
}

/** at most this many toasts at once */
export const MAX_TOASTS = 4

/**
 * Adds `next` to the shown toasts: it replaces a toast with the same key; when there are too many,
 * the oldest go first – sticky ones only when nothing else is left.
 */
export function addToast<T extends ToastEvent>(toasts: readonly T[], next: T): T[] {
  const list = next.key ? toasts.filter((toast) => toast.key !== next.key) : [...toasts]
  list.push(next)
  while (list.length > MAX_TOASTS) {
    const oldest = list.findIndex((toast) => !toast.sticky)
    list.splice(oldest >= 0 ? oldest : 0, 1)
  }
  return list
}

/**
 * The toasts left when the user goes to another project (or the start screen: null): the ones
 * about another project leave, and so do toast buttons (e.g. "Undo") – they belong to the
 * screen they were offered on.
 */
export function toastsForScreen<T extends ToastEvent & { action?: unknown }>(
  toasts: readonly T[],
  projectId: string | null
): T[] {
  return toasts.filter(
    (toast) => !toast.action && (toast.projectId === undefined || toast.projectId === projectId)
  )
}
