import { describe, expect, it } from 'vitest'
import { TOAST_KEYS } from '@shared/ipc'
import type { ToastEvent } from '@shared/types'
import { JOB_MESSAGES } from '../../../main/core/jobs/messages'
import { storeNoticeToast } from '../../../main/core/project/store'
import { addToast, MAX_TOASTS, toastDuration, toastsForScreen } from './toast'

const QUOTA_DAY =
  'Your daily Gemini quota is used up. Try again tomorrow, switch to Gemini 3.5 Flash-Lite in ' +
  'Settings or turn on billing in Google AI Studio.'

type Item = ToastEvent & { id: number; action?: { label: string; run: () => void } }

let seq = 0
const item = (event: Partial<ToastEvent> & { action?: Item['action'] } = {}): Item => ({
  id: ++seq,
  level: 'info',
  message: `Notice ${seq}`,
  ...event
})

describe('toastDuration', () => {
  it('keeps sticky toasts until they are closed', () => {
    expect(
      toastDuration('warning', `1 video could not be analysed: ${QUOTA_DAY}`, false, true)
    ).toBeNull()
    // main marks what nobody may miss – not the text
    expect(toastDuration('warning', JOB_MESSAGES.analysisPartlyFailed(1, QUOTA_DAY))).not.toBeNull()
    // e.g. unsaved changes: until "Everything is saved again." replaces it
    const saveFailed = storeNoticeToast({ type: 'save-failed' })
    expect(toastDuration(saveFailed.level, saveFailed.message, false, saveFailed.sticky)).toBeNull()
  })

  it('gives longer texts more time, within limits per level', () => {
    expect(toastDuration('success', 'Command copied.')).toBe(4_500)
    const kept =
      'Analysis done: 5 new suggestions. Your selection stays, you will find the new moments ' +
      'under “More suggestions”.'
    expect(toastDuration('success', kept)).toBeGreaterThan(7_000)
    expect(toastDuration('success', kept.repeat(5))).toBe(10_000)
    expect(toastDuration('warning', 'Short.')).toBe(7_000)
    expect(toastDuration('error', QUOTA_DAY)).toBeGreaterThan(9_000)
    expect(toastDuration('error', QUOTA_DAY.repeat(5))).toBe(25_000)
  })

  it('adds time to reach the button of an action toast', () => {
    expect(toastDuration('info', '“Drop” was removed from the highlight video.', true)).toBe(7_500)
  })
})

describe('addToast', () => {
  it('replaces the toast with the same key – "Everything is saved again." closes the warning', () => {
    const failed = item({ ...storeNoticeToast({ type: 'save-failed' }) })
    const other = item()
    const recovered = item({ ...storeNoticeToast({ type: 'save-recovered' }) })
    expect(failed.key).toBe(TOAST_KEYS.projectSave)
    expect(addToast([failed, other], recovered)).toEqual([other, recovered])
  })

  it('drops the oldest when there are too many – sticky ones last', () => {
    const sticky = item({ sticky: true })
    const others = Array.from({ length: MAX_TOASTS }, () => item())
    const list = others.reduce<Item[]>((shown, next) => addToast(shown, next), [sticky])
    expect(list).toHaveLength(MAX_TOASTS)
    expect(list[0]).toBe(sticky)
    expect(list.slice(1)).toEqual(others.slice(1))
    // only sticky ones: the oldest of them goes
    const stickies = Array.from({ length: MAX_TOASTS + 1 }, () => item({ sticky: true }))
    expect(stickies.reduce<Item[]>((shown, next) => addToast(shown, next), [])).toEqual(
      stickies.slice(1)
    )
  })
})

describe('toastsForScreen', () => {
  it('keeps toasts about the project that opens and app-wide ones, drops buttons', () => {
    const runA = item({ level: 'warning', projectId: 'a', sticky: true })
    const exportB = item({ level: 'error', projectId: 'b', sticky: true })
    const saveFailed = item({ ...storeNoticeToast({ type: 'save-failed' }) })
    const undo = item({ action: { label: 'Undo', run: () => undefined } })
    const all = [runA, exportB, saveFailed, undo]
    expect(toastsForScreen(all, 'a')).toEqual([runA, saveFailed])
    // the start screen: nothing that belongs to a project
    expect(toastsForScreen(all, null)).toEqual([saveFailed])
  })
})
