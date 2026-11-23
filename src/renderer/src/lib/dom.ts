// Small DOM/React helpers.

import type { DragEvent as ReactDragEvent } from 'react'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

const NON_TEXT_INPUTS = new Set([
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'range',
  'color'
])

/** the parts of an element isTypingTarget looks at (structural, so it also works in unit tests) */
interface ElementLike {
  tagName?: unknown
  isContentEditable?: unknown
  type?: unknown
}

/** true while the user types into a text field – global shortcuts must not fire then */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as ElementLike | null
  if (!element || typeof element.tagName !== 'string') return false
  if (element.isContentEditable === true) return true
  const tag = element.tagName.toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  const type = typeof element.type === 'string' ? element.type.toLowerCase() : 'text'
  return !NON_TEXT_INPUTS.has(type)
}

/** true when the drag carries files from Finder (as opposed to in-app drags) */
export function isFileDrag(event: DragEvent | ReactDragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}
