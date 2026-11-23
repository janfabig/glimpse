// Single-range HTTP Range header parsing (RFC 9110 §14) for video seeking.

/** inclusive byte offsets */
export interface ByteRange {
  start: number
  end: number
}

export type RangeRequest =
  { kind: 'none' } | { kind: 'range'; range: ByteRange } | { kind: 'unsatisfiable' }

const RANGE_PATTERN = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)$/i

/**
 * `bytes=a-b`, `bytes=a-` and `bytes=-n` against a file of `size` bytes. Anything else
 * (other units, multiple ranges, garbage) and ranges outside the file are unsatisfiable.
 */
export function parseRange(header: string | null | undefined, size: number): RangeRequest {
  if (header === null || header === undefined || header.trim() === '') return { kind: 'none' }
  const match = RANGE_PATTERN.exec(header.trim())
  if (!match) return { kind: 'unsatisfiable' }
  const [, first, last] = match
  if (first === '' && last === '') return { kind: 'unsatisfiable' }

  if (first === '') {
    const suffix = Number(last)
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' }
    return { kind: 'range', range: { start: Math.max(0, size - suffix), end: size - 1 } }
  }

  const start = Number(first)
  if (start >= size) return { kind: 'unsatisfiable' }
  if (last === '') return { kind: 'range', range: { start, end: size - 1 } }
  const end = Number(last)
  if (end < start) return { kind: 'unsatisfiable' }
  return { kind: 'range', range: { start, end: Math.min(end, size - 1) } }
}
