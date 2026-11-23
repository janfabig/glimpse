import { describe, expect, it } from 'vitest'
import { formatDurationDe, formatTimecode, parseTimestamp } from './time'

describe('parseTimestamp', () => {
  it.each([
    ['00:00', 0],
    ['0:05', 5],
    ['01:15', 75],
    ['1:15.5', 75.5],
    ['1:02:05', 3725],
    ['12', 12],
    ['12.5s', 12.5],
    ['3,5', 3.5],
    [42, 42]
  ])('parses %s', (input, expected) => {
    expect(parseTimestamp(input)).toBe(expected)
  })

  it.each([['abc'], [''], ['1:75'], ['-3'], [-1], [NaN], [null], ['1:2:3:4'], ['1:60:00']])(
    'rejects %s',
    (input) => {
      expect(parseTimestamp(input)).toBeNull()
    }
  )
})

describe('formatting', () => {
  it('formats timecodes', () => {
    expect(formatTimecode(75.4)).toBe('1:15')
    expect(formatTimecode(75.44, 1)).toBe('1:15.4')
    expect(formatTimecode(3725)).toBe('1:02:05')
    expect(formatTimecode(-3)).toBe('0:00')
  })

  it('formats durations', () => {
    expect(formatDurationDe(42)).toBe('42 s')
    expect(formatDurationDe(95)).toBe('1:35 min')
  })
})
