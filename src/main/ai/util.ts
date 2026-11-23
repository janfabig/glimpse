// Small pure helpers shared inside the ai module.

/** Cuts `text` to at most `max` characters, preferring a word boundary, and marks the cut with "…". */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const hard = text.slice(0, Math.max(0, max - 1))
  const space = hard.lastIndexOf(' ')
  const cut = space > max / 2 ? hard.slice(0, space) : hard
  return `${cut.trimEnd()}…`
}

/** Collapses whitespace; non-strings become ''. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return truncate(value.replace(/\s+/g, ' ').trim(), max)
}

/** "MM:SS" rounded down (never points past the end of a video), minutes may exceed 59. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const minutes = Math.floor(total / 60)
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
