import { describe, expect, it } from 'vitest'
import { parseRange } from './range'

const range = (start: number, end: number): ReturnType<typeof parseRange> => ({
  kind: 'range',
  range: { start, end }
})

describe('parseRange', () => {
  it('returns none without a header', () => {
    expect(parseRange(null, 100)).toEqual({ kind: 'none' })
    expect(parseRange(undefined, 100)).toEqual({ kind: 'none' })
    expect(parseRange('  ', 100)).toEqual({ kind: 'none' })
  })

  it('parses bytes=a-b and clamps the end to the file', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual(range(0, 9))
    expect(parseRange('bytes=50-50', 100)).toEqual(range(50, 50))
    expect(parseRange('bytes=90-500', 100)).toEqual(range(90, 99))
    expect(parseRange('BYTES = 1 - 2', 100)).toEqual(range(1, 2))
  })

  it('parses open-ended and suffix ranges', () => {
    expect(parseRange('bytes=10-', 100)).toEqual(range(10, 99))
    expect(parseRange('bytes=0-', 1)).toEqual(range(0, 0))
    expect(parseRange('bytes=-10', 100)).toEqual(range(90, 99))
    expect(parseRange('bytes=-500', 100)).toEqual(range(0, 99))
  })

  it('rejects unsatisfiable and malformed ranges', () => {
    for (const header of [
      'bytes=100-',
      'bytes=100-200',
      'bytes=5-4',
      'bytes=-0',
      'bytes=-',
      'bytes=abc',
      'bytes=0-1,5-6',
      'items=0-1',
      'bytes=1.5-3',
      '0-1'
    ]) {
      expect(parseRange(header, 100), header).toEqual({ kind: 'unsatisfiable' })
    }
  })

  it('has nothing to serve from an empty file', () => {
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange('bytes=-1', 0)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange(null, 0)).toEqual({ kind: 'none' })
  })
})
