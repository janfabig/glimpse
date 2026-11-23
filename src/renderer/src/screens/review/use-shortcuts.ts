import { useEffect, useRef } from 'react'
import { isTypingTarget } from '../../lib/dom'

export type ShortcutMap = Partial<Record<string, () => void>>

/** keys that may auto-repeat while held (stepping through clips, scrubbing, trimming) */
const REPEATABLE = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  ',',
  '.',
  '-',
  '+',
  '='
])

export type ShortcutEvent = Pick<
  KeyboardEvent,
  'key' | 'repeat' | 'metaKey' | 'ctrlKey' | 'altKey' | 'defaultPrevented' | 'target'
>

/**
 * What a key press means for the map: `null` = not ours (let the browser handle it), otherwise
 * the event is consumed and `run` is the action – or null for a held toggle key (Space, X, I, O),
 * so holding it does not flip the state back and forth.
 */
export function matchShortcut(
  event: ShortcutEvent,
  map: ShortcutMap
): { run: (() => void) | null } | null {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return null
  if (isTypingTarget(event.target)) return null
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  const action = map[key]
  if (!action) return null
  return { run: event.repeat && !REPEATABLE.has(key) ? null : action }
}

/**
 * Global single-key shortcuts (e.g. ' ', 'ArrowUp', 'i'). Ignored while typing in a text field,
 * with modifier keys held, or when `enabled` is false.
 */
export function useShortcuts(map: ShortcutMap, enabled: boolean): void {
  const mapRef = useRef(map)
  useEffect(() => {
    mapRef.current = map
  })

  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent): void => {
      const match = matchShortcut(event, mapRef.current)
      if (!match) return
      event.preventDefault()
      match.run?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}
