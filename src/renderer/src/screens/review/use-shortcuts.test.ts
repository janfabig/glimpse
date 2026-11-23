import { describe, expect, it } from 'vitest'
import { isTypingTarget } from '../../lib/dom'
import { matchShortcut, type ShortcutEvent } from './use-shortcuts'

const noop = (): void => undefined
const map = { ' ': noop, x: noop, ArrowDown: noop }

function key(value: string, extra: Partial<ShortcutEvent> = {}): ShortcutEvent {
  return {
    key: value,
    repeat: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    defaultPrevented: false,
    target: null,
    ...extra
  }
}

describe('matchShortcut', () => {
  it('runs mapped keys, case-insensitive', () => {
    expect(matchShortcut(key('X'), map)?.run).toBe(noop)
    expect(matchShortcut(key(' '), map)?.run).toBe(noop)
    expect(matchShortcut(key('q'), map)).toBeNull()
  })

  it('swallows auto-repeat of toggle keys but lets arrows repeat', () => {
    expect(matchShortcut(key('x', { repeat: true }), map)).toEqual({ run: null })
    expect(matchShortcut(key(' ', { repeat: true }), map)).toEqual({ run: null })
    expect(matchShortcut(key('ArrowDown', { repeat: true }), map)?.run).toBe(noop)
  })

  it('keeps trimming while a trim key is held, but not toggling', () => {
    const trims = [',', '.', '-', '+', '=']
    const toggles = [' ', 'x', 'i', 'o']
    const keys = Object.fromEntries([...trims, ...toggles].map((value) => [value, noop]))
    for (const value of trims) {
      expect(matchShortcut(key(value, { repeat: true }), keys)?.run).toBe(noop)
    }
    for (const value of toggles) {
      expect(matchShortcut(key(value, { repeat: true }), keys)).toEqual({ run: null })
    }
  })

  it('leaves modified keys, handled events and text fields alone', () => {
    expect(matchShortcut(key('x', { metaKey: true }), map)).toBeNull()
    expect(matchShortcut(key('x', { defaultPrevented: true }), map)).toBeNull()
    const input = { tagName: 'INPUT', type: 'text' } as unknown as EventTarget
    expect(matchShortcut(key('x', { target: input }), map)).toBeNull()
  })
})

describe('isTypingTarget', () => {
  const element = (props: Record<string, unknown>): EventTarget => props as unknown as EventTarget

  it('detects text entry but not buttons, checkboxes or sliders', () => {
    expect(isTypingTarget(element({ tagName: 'TEXTAREA' }))).toBe(true)
    expect(isTypingTarget(element({ tagName: 'SELECT' }))).toBe(true)
    expect(isTypingTarget(element({ tagName: 'INPUT', type: 'search' }))).toBe(true)
    expect(isTypingTarget(element({ tagName: 'DIV', isContentEditable: true }))).toBe(true)
    expect(isTypingTarget(element({ tagName: 'INPUT', type: 'range' }))).toBe(false)
    expect(isTypingTarget(element({ tagName: 'INPUT', type: 'checkbox' }))).toBe(false)
    expect(isTypingTarget(element({ tagName: 'BUTTON' }))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})
