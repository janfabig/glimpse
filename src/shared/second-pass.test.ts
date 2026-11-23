import { describe, expect, it } from 'vitest'
import { LIMITS } from './presets'
import { appendWish, wishProblem } from './second-pass'

describe('appendWish', () => {
  it('adds the wish as a new last line, both trimmed', () => {
    expect(appendWish('  Show the drops.\n', '  Less stage, more friends. \n')).toBe(
      'Show the drops.\nLess stage, more friends.'
    )
  })

  it('keeps the lines of the prompt and of the wish', () => {
    expect(appendWish('One.\n\nTwo.', 'Three.\nFour.')).toBe('One.\n\nTwo.\nThree.\nFour.')
  })

  it('does not add a wish twice that is already the end of the prompt (sent again after a failed run)', () => {
    expect(appendWish('Show the drops.\nMore crowd.', ' More crowd. ')).toBe(
      'Show the drops.\nMore crowd.'
    )
    expect(appendWish('More crowd.', 'More crowd.')).toBe('More crowd.')
    expect(appendWish('One.\nThree.\nFour.', 'Three.\nFour.')).toBe('One.\nThree.\nFour.')
    // only a whole last line counts
    expect(appendWish('Much More crowd.', 'More crowd.')).toBe('Much More crowd.\nMore crowd.')
  })

  it('is the wish alone when the prompt is empty', () => {
    expect(appendWish('  \n', 'Only the crowd.')).toBe('Only the crowd.')
  })
})

describe('wishProblem', () => {
  it('needs text', () => {
    expect(wishProblem('Show the drops.', '')).toBe('empty')
    expect(wishProblem('Show the drops.', ' \n\t ')).toBe('empty')
    expect(wishProblem('Show the drops.', 'More crowd.')).toBeNull()
  })

  it('needs the prompt with the new line to fit into the longest prompt', () => {
    const prompt = 'a'.repeat(LIMITS.promptMax - 10)
    // prompt + line break + 9 characters = exactly the limit
    expect(wishProblem(prompt, 'b'.repeat(9))).toBeNull()
    expect(wishProblem(prompt, 'b'.repeat(10))).toBe('too-long')
    // what gets trimmed away does not count
    expect(wishProblem(prompt, `  ${'b'.repeat(9)}  `)).toBeNull()
    expect(wishProblem('', 'b'.repeat(LIMITS.promptMax + 1))).toBe('too-long')
  })
})
