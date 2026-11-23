// "Ask Gemini again" (docs/ARCHITECTURE.md §5 Jobs, "Second pass"): what the user wants changed
// becomes a new last line of the prompt. Shared, so main, the dialog and the mock API agree
// on the result.

import { LIMITS } from './presets'

/** the prompt with `wish` as its last line (both trimmed) */
export function appendWish(prompt: string, wish: string): string {
  const base = prompt.trim()
  const line = wish.trim()
  // sent again (e.g. after a failed run): the wish already is the end of the prompt
  if (base === line || base.endsWith(`\n${line}`)) return base
  return base ? `${base}\n${line}` : line
}

/** why the run cannot start with this text – null: it can */
export function wishProblem(prompt: string, wish: string): 'empty' | 'too-long' | null {
  if (!wish.trim()) return 'empty'
  return appendWish(prompt, wish).length > LIMITS.promptMax ? 'too-long' : null
}
