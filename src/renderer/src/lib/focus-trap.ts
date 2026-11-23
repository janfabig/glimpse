// Keeps keyboard focus inside an open dialog: Tab after the last control goes to the first one,
// Shift+Tab before the first one to the last – never to the screen behind the backdrop.

const FOCUSABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

/**
 * Index of the control to focus for Tab (or Shift+Tab with `backwards`) when focus has to wrap
 * around; null when the browser's own move stays inside the dialog. `current` is the index of the
 * focused control, -1 when focus is elsewhere (on the dialog itself, the page behind it, nowhere).
 */
export function wrapFocusIndex(count: number, current: number, backwards: boolean): number | null {
  if (count === 0) return null
  if (current < 0 || current >= count) return backwards ? count - 1 : 0
  if (backwards && current === 0) return count - 1
  if (!backwards && current === count - 1) return 0
  return null
}

/** the controls of `root` that Tab can reach, in document order */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.tabIndex >= 0 && element.getClientRects().length > 0
  )
}

/**
 * Handles a Tab key press for the dialog `root`; returns true when it moved focus itself (the
 * caller then prevents the browser's default).
 */
export function trapTab(root: HTMLElement, backwards: boolean): boolean {
  const controls = focusableIn(root)
  const active = root.ownerDocument.activeElement
  if (controls.length === 0) {
    root.focus()
    return true
  }
  const index = wrapFocusIndex(
    controls.length,
    controls.findIndex((control) => control === active),
    backwards
  )
  if (index === null) return false
  controls[index].focus()
  return true
}
