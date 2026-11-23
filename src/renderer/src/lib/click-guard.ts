// Buttons that remove or move an item sit in lists that reflow as soon as main answers. The second
// click of a double click – or a quick second click on the same spot – would then hit the button of
// the next item, which slid in under the pointer. A press anywhere else in between ends that window:
// the user moved on, so the next click on that spot is meant (X on a video → "Remove" in the
// dialog → the X of another video that now sits on the same spot).

export interface ClickInfo {
  /** click count from the OS: 2 for the second click of a double click, 0 for keyboard clicks */
  detail: number
  clientX: number
  clientY: number
  /** milliseconds on any monotonic clock (event.timeStamp) */
  time: number
}

/** where the pointer went down (pointerdown) */
export interface PressInfo {
  clientX: number
  clientY: number
}

export interface RepeatClickFilter {
  /**
   * true when the click must be ignored: every click after the first of a double (or triple)
   * click, and a single click that follows the last handled one within the window on the same spot
   * with no press anywhere else in between. Keyboard clicks (detail 0) always pass – nothing moves
   * under them.
   */
  isRepeat(click: ClickInfo): boolean
  /** a press anywhere: away from the last handled click, it ends that click's repeat window */
  notePress(press: PressInfo): void
}

/** a click this soon after the last one, on (almost) the same spot, belongs to the first one */
export const REPEAT_WINDOW_MS = 500
const REPEAT_RADIUS_PX = 8

export function createRepeatClickFilter(
  windowMs = REPEAT_WINDOW_MS,
  radiusPx = REPEAT_RADIUS_PX
): RepeatClickFilter {
  let last: ClickInfo | null = null
  const near = (a: PressInfo, b: PressInfo): boolean =>
    Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) <= radiusPx
  return {
    isRepeat(click) {
      if (click.detail > 1) return true
      if (click.detail === 0) return false
      const repeat =
        last !== null &&
        click.time - last.time >= 0 &&
        click.time - last.time < windowMs &&
        near(click, last)
      if (!repeat) last = click
      return repeat
    },
    notePress(press) {
      if (last !== null && !near(press, last)) last = null
    }
  }
}

/**
 * Reports every press in `target` to `filter` – in the capture phase, so a component that stops the
 * event cannot hide it. Returns the function that stops watching.
 */
export function watchPresses(filter: RepeatClickFilter, target: EventTarget): () => void {
  const listener = (event: Event): void => filter.notePress(event as PointerEvent)
  target.addEventListener('pointerdown', listener, { capture: true, passive: true })
  return () => target.removeEventListener('pointerdown', listener, { capture: true })
}

const shared = createRepeatClickFilter()
// the renderer; the unit tests run in Node without a window
if (typeof window !== 'undefined') watchPresses(shared, window)

/**
 * One filter for every item button of the app (remove a video, take a clip out of or into the
 * highlight video, play an original): the next item's button may belong to
 * another component.
 */
export function isRepeatClick(event: {
  detail: number
  clientX: number
  clientY: number
  timeStamp: number
}): boolean {
  return shared.isRepeat({
    detail: event.detail,
    clientX: event.clientX,
    clientY: event.clientY,
    time: event.timeStamp
  })
}
