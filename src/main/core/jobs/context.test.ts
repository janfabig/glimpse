import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deferred } from '../testing/helpers'
import { abortable, TaskTracker } from './context'

describe('abortable', () => {
  const unhandled: unknown[] = []
  const record = (reason: unknown): void => void unhandled.push(reason)

  beforeEach(() => {
    unhandled.length = 0
    process.on('unhandledRejection', record)
  })

  afterEach(() => {
    process.off('unhandledRejection', record)
  })

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

  it('passes the result through while the signal stays quiet', async () => {
    await expect(abortable(Promise.resolve(7), new AbortController().signal)).resolves.toBe(7)
    await expect(
      abortable(Promise.reject(new Error('boom')), new AbortController().signal)
    ).rejects.toThrow('boom')
  })

  it('rejects at once when the signal aborts, and swallows the late failure', async () => {
    const controller = new AbortController()
    const late = deferred<void>()
    const wrapped = abortable(late.promise, controller.signal)
    controller.abort()
    await expect(wrapped).rejects.toMatchObject({ name: 'AbortError' })
    late.reject(new Error('late failure'))
    await settle()
    expect(unhandled).toEqual([])
  })

  it('never leaves the promise unhandled when the signal had already aborted', async () => {
    const late = deferred<void>()
    await expect(abortable(late.promise, AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError'
    })
    late.reject(new Error('late failure'))
    await settle()
    expect(unhandled).toEqual([])
  })
})

describe('TaskTracker', () => {
  it('reports busy when the first task starts and idle when the last one ends', async () => {
    const changes: boolean[] = []
    const tasks = new TaskTracker((busy) => changes.push(busy))
    const a = deferred<void>()
    const b = deferred<void>()
    tasks.track('p1', a.promise)
    tasks.track('p2', b.promise)
    expect(changes).toEqual([true])
    a.resolve()
    await tasks.settled('p1')
    expect(changes).toEqual([true])
    // a failed task ends the busy phase as well
    b.reject(new Error('boom'))
    await tasks.settled()
    expect(changes).toEqual([true, false])
    tasks.track('p1', Promise.resolve())
    await tasks.settled()
    expect(changes).toEqual([true, false, true, false])
  })
})
