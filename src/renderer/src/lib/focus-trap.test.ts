import { describe, expect, it } from 'vitest'
import { wrapFocusIndex } from './focus-trap'

describe('wrapFocusIndex', () => {
  it('wraps around at both ends', () => {
    expect(wrapFocusIndex(3, 2, false)).toBe(0)
    expect(wrapFocusIndex(3, 0, true)).toBe(2)
    expect(wrapFocusIndex(1, 0, false)).toBe(0)
    expect(wrapFocusIndex(1, 0, true)).toBe(0)
  })

  it('leaves moves inside the dialog to the browser', () => {
    expect(wrapFocusIndex(3, 0, false)).toBeNull()
    expect(wrapFocusIndex(3, 1, false)).toBeNull()
    expect(wrapFocusIndex(3, 2, true)).toBeNull()
  })

  it('pulls focus back in from outside (or from the dialog itself)', () => {
    expect(wrapFocusIndex(3, -1, false)).toBe(0)
    expect(wrapFocusIndex(3, -1, true)).toBe(2)
    expect(wrapFocusIndex(0, -1, false)).toBeNull()
  })
})
