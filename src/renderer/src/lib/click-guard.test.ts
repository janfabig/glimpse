import { describe, expect, it } from 'vitest'
import {
  createRepeatClickFilter,
  REPEAT_WINDOW_MS,
  watchPresses,
  type ClickInfo
} from './click-guard'

const click = (time: number, extra: Partial<ClickInfo> = {}): ClickInfo => ({
  detail: 1,
  clientX: 100,
  clientY: 200,
  time,
  ...extra
})

/** a pointerdown as the browser dispatches it (Node has EventTarget, but no PointerEvent) */
const press = (clientX: number, clientY: number): Event =>
  Object.assign(new Event('pointerdown'), { clientX, clientY })

describe('createRepeatClickFilter', () => {
  it('ignores the second click of a double click, wherever it lands', () => {
    const { isRepeat: ignore } = createRepeatClickFilter()
    expect(ignore(click(0))).toBe(false)
    expect(ignore(click(90, { detail: 2 }))).toBe(true)
    expect(ignore(click(150, { detail: 3, clientX: 400 }))).toBe(true)
  })

  it('ignores a quick second click on the same spot – the next item slid in under it', () => {
    for (const gap of [40, 90, 150, 300]) {
      const { isRepeat: ignore } = createRepeatClickFilter()
      expect(ignore(click(1_000))).toBe(false)
      expect(ignore(click(1_000 + gap, { clientX: 103, clientY: 198 })), `${gap} ms`).toBe(true)
    }
  })

  it('lets deliberate clicks through', () => {
    const { isRepeat: ignore } = createRepeatClickFilter()
    expect(ignore(click(0))).toBe(false)
    // later on the same spot
    expect(ignore(click(REPEAT_WINDOW_MS + 1))).toBe(false)
    // right away, but on another item's button
    expect(ignore(click(REPEAT_WINDOW_MS + 60, { clientX: 300 }))).toBe(false)
    // keyboard clicks have no position and never repeat
    expect(ignore(click(REPEAT_WINDOW_MS + 70, { detail: 0, clientX: 0, clientY: 0 }))).toBe(false)
    expect(ignore(click(REPEAT_WINDOW_MS + 80, { detail: 0, clientX: 0, clientY: 0 }))).toBe(false)
  })

  it('measures from the last click it let through', () => {
    const { isRepeat: ignore } = createRepeatClickFilter()
    expect(ignore(click(0))).toBe(false)
    expect(ignore(click(300))).toBe(true)
    // 600 ms after the handled click, even though only 300 ms after the ignored one
    expect(ignore(click(600))).toBe(false)
  })

  it('lets a click through when the user pressed somewhere else in between', () => {
    // E2E "removing videos": X of a video with clips → "Remove" in the dialog → steps → "Add
    // videos" → X of the new video, which sits where the removed one was – 470 ms in all
    const { isRepeat: ignore, notePress } = createRepeatClickFilter()
    expect(ignore(click(8_215, { clientX: 429, clientY: 185 }))).toBe(false)
    notePress({ clientX: 680, clientY: 520 })
    expect(ignore(click(8_685, { clientX: 429, clientY: 185 }))).toBe(false)
  })

  it('keeps the window for presses on the same spot – they belong to the repeated click', () => {
    const { isRepeat: ignore, notePress } = createRepeatClickFilter()
    expect(ignore(click(0))).toBe(false)
    notePress({ clientX: 102, clientY: 197 })
    expect(ignore(click(150, { clientX: 102, clientY: 197 }))).toBe(true)
    // a press elsewhere also ends nothing for the second click of a double click
    notePress({ clientX: 600, clientY: 40 })
    expect(ignore(click(200, { detail: 2 }))).toBe(true)
  })
})

describe('watchPresses', () => {
  it('reports every pointerdown of the target until it is stopped', () => {
    const filter = createRepeatClickFilter()
    const target = new EventTarget()
    const stop = watchPresses(filter, target)

    expect(filter.isRepeat(click(0))).toBe(false)
    target.dispatchEvent(press(400, 50))
    expect(filter.isRepeat(click(100)), 'a press elsewhere came first').toBe(false)

    stop()
    target.dispatchEvent(press(400, 50))
    expect(filter.isRepeat(click(200)), 'no longer watched').toBe(true)
  })
})
