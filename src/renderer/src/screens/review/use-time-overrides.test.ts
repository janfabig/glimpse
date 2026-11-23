import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Moment, Project, ProjectMutation } from '@shared/types'
import type { TimeRange } from '../../lib/moments'

// The tests run in Node without a DOM: a minimal stand-in for React's hooks keeps the hook's state
// between calls of render(), which is all this hook needs (useState, useRef, useCallback).
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0 }))
vi.mock('react', () => {
  const cell = <T>(initial: () => T): { index: number; value: T } => {
    const index = hooks.cursor++
    if (!(index in hooks.cells)) hooks.cells[index] = initial()
    return { index, value: hooks.cells[index] as T }
  }
  return {
    useState: <T>(initial: T) => {
      const { index, value } = cell(() => initial)
      const set = (next: T | ((current: T) => T)): void => {
        const current = hooks.cells[index] as T
        hooks.cells[index] = typeof next === 'function' ? (next as (c: T) => T)(current) : next
      }
      return [value, set]
    },
    useRef: <T>(initial: T) => cell(() => ({ current: initial })).value,
    useCallback: <T>(fn: T) => fn
  }
})

/** every updateMomentTimes the hook sent, to be answered by the test */
const sent = vi.hoisted(() => [] as { mutation: ProjectMutation; answer: (ok: boolean) => void }[])
vi.mock('../../store/actions', () => ({
  // like the real one: resolves with the project, or with null after main refused (it never throws)
  mutate: (mutation: ProjectMutation) =>
    new Promise<Project | null>((resolve) => {
      sent.push({ mutation, answer: (ok) => resolve(ok ? ({} as Project) : null) })
    })
}))

const { useTimeOverrides } = await import('./use-time-overrides')

const render = (): ReturnType<typeof useTimeOverrides> => {
  hooks.cursor = 0
  // eslint-disable-next-line react-hooks/rules-of-hooks -- the stand-in above, not React
  return useTimeOverrides()
}
const saved = { id: 'm1', start: 10, end: 16 } as Moment
const shown = (): TimeRange => render().timesOf(saved)
/** main answers the nth commit; the hook then runs on */
const answer = async (n: number, ok = true): Promise<void> => {
  sent[n].answer(ok)
  await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  hooks.cells.length = 0
  sent.length = 0
})

describe('useTimeOverrides', () => {
  it('shows a trim at once and the saved times again when main has answered', async () => {
    expect(shown()).toEqual({ start: 10, end: 16 })
    const done = render().commit('m1', { start: 11, end: 16 })
    expect(shown()).toEqual({ start: 11, end: 16 })
    expect(sent.map((s) => s.mutation)).toEqual([
      { type: 'updateMomentTimes', momentId: 'm1', start: 11, end: 16 }
    ])
    await answer(0)
    await done
    expect(shown()).toEqual({ start: 10, end: 16 })
  })

  it('keeps the latest trim while an earlier commit of the clip returns (held trim key)', async () => {
    void render().commit('m1', { start: 11, end: 16 })
    void render().commit('m1', { start: 12, end: 16 })
    await answer(0)
    expect(shown()).toEqual({ start: 12, end: 16 })
    await answer(1)
    expect(shown()).toEqual({ start: 10, end: 16 })
  })

  it('goes back to the saved times when main refuses the trim', async () => {
    void render().commit('m1', { start: 11, end: 16 })
    await answer(0, false)
    expect(shown()).toEqual({ start: 10, end: 16 })
  })

  it('keeps the overrides of other clips apart', async () => {
    const other = { id: 'm2', start: 30, end: 34 } as Moment
    void render().commit('m1', { start: 11, end: 16 })
    void render().commit('m2', { start: 30, end: 33 })
    await answer(0)
    expect(shown()).toEqual({ start: 10, end: 16 })
    expect(render().timesOf(other)).toEqual({ start: 30, end: 33 })
  })

  it('shows and drops a draft without sending anything', () => {
    render().preview('m1', { start: 9, end: 16 })
    expect(shown()).toEqual({ start: 9, end: 16 })
    render().preview('m1', null)
    expect(shown()).toEqual({ start: 10, end: 16 })
    expect(sent).toEqual([])
  })

  it('keeps the draft of a drag that began while a commit of the clip was under way', async () => {
    void render().commit('m1', { start: 11, end: 16 })
    render().preview('m1', { start: 11, end: 18 })
    await answer(0)
    expect(shown()).toEqual({ start: 11, end: 18 })
    // the drag ends where it began: the draft goes, nothing is left behind
    render().preview('m1', null)
    expect(shown()).toEqual({ start: 10, end: 16 })
  })
})
