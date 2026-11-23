import type { Moment } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { makeMoment, makeVideo } from '../testing/fixtures'
import { insertChronologically } from './order'

const videos = ['v1', 'v2', 'v3'].map((id) => makeVideo({ id }))
/** `v1@10` → a moment of v1 starting at 10 s */
const m = (key: string): Moment => {
  const [videoId, start] = key.split('@')
  return makeMoment({ id: key, videoId, start: Number(start), end: Number(start) + 2 })
}
const insert = (existing: string[], added: string[]): string[] =>
  insertChronologically(existing.map(m), added.map(m), videos).map((moment) => moment.id)

describe('insertChronologically', () => {
  it('puts moments at their chronological place in a chronological list', () => {
    expect(insert([], ['v2@5', 'v1@3'])).toEqual(['v1@3', 'v2@5'])
    expect(insert(['v1@10', 'v2@0', 'v3@4'], ['v1@20', 'v1@1', 'v3@9'])).toEqual([
      'v1@1',
      'v1@10',
      'v1@20',
      'v2@0',
      'v3@4',
      'v3@9'
    ])
    // equal keys: after the existing one
    expect(insert(['v1@10', 'v2@0'], ['v1@10'])).toEqual(['v1@10', 'v1@10', 'v2@0'])
  })

  it('keeps a reordered list as it is and inserts next to the chronological neighbour', () => {
    // v3@4 was moved to the front, v1@2 to the end
    const reordered = ['v3@4', 'v1@10', 'v2@0', 'v2@30', 'v1@2']
    expect(insert(reordered, ['v2@12'])).toEqual([
      'v3@4',
      'v1@10',
      'v2@0',
      'v2@12',
      'v2@30',
      'v1@2'
    ])
    // no earlier moment: right before the closest later one
    expect(insert(reordered, ['v1@0'])).toEqual(['v3@4', 'v1@10', 'v2@0', 'v2@30', 'v1@0', 'v1@2'])
    // a video without moments goes after the latest moment of an earlier video
    expect(insert(['v3@4', 'v1@10'], ['v2@7', 'v2@8'])).toEqual(['v3@4', 'v1@10', 'v2@7', 'v2@8'])
  })

  it('places moments of unknown videos last', () => {
    expect(insert(['v1@1', 'gone@0'], ['v3@1'])).toEqual(['v1@1', 'v3@1', 'gone@0'])
  })
})
