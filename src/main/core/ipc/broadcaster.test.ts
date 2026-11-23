import { IPC_EVENTS } from '@shared/ipc'
import type { ExportProgress, Project } from '@shared/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeProject } from '../testing/fixtures'
import { Broadcaster } from './broadcaster'

let sent: { channel: string; payload: unknown }[]
let broadcaster: Broadcaster

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  broadcaster = new Broadcaster({ send: (channel, payload) => sent.push({ channel, payload }) })
})

afterEach(() => {
  broadcaster.dispose()
  vi.useRealTimers()
})

const project = (id: string, name: string): Project => makeProject({ id, name })
const names = (): string[] =>
  sent
    .filter((s) => s.channel === IPC_EVENTS.projectUpdated)
    .map((s) => (s.payload as Project).name)

function progress(phase: ExportProgress['phase'], value: number, projectId = 'p1'): ExportProgress {
  return { projectId, exportId: 'e1', phase, progress: value }
}

const phases = (): string[] =>
  sent
    .filter((s) => s.channel === IPC_EVENTS.exportProgress)
    .map((s) => {
      const event = s.payload as ExportProgress
      return `${event.phase}:${event.progress}`
    })

describe('project updates', () => {
  it('sends the first update at once and at most 5 per second afterwards', () => {
    for (let i = 1; i <= 50; i++) {
      broadcaster.projectUpdated(project('p1', `v${i}`))
      vi.advanceTimersByTime(20)
    }
    // 50 updates over 1 s → leading edge + one per 200 ms
    expect(names().length).toBeLessThanOrEqual(6)
    expect(names()[0]).toBe('v1')
  })

  it('always delivers the latest state (trailing edge)', () => {
    broadcaster.projectUpdated(project('p1', 'first'))
    broadcaster.projectUpdated(project('p1', 'second'))
    broadcaster.projectUpdated(project('p1', 'third'))
    expect(names()).toEqual(['first'])
    vi.advanceTimersByTime(199)
    expect(names()).toEqual(['first'])
    vi.advanceTimersByTime(1)
    expect(names()).toEqual(['first', 'third'])
    vi.advanceTimersByTime(1000)
    expect(names()).toEqual(['first', 'third'])
  })

  it('throttles each project separately', () => {
    broadcaster.projectUpdated(project('p1', 'a1'))
    broadcaster.projectUpdated(project('p2', 'b1'))
    broadcaster.projectUpdated(project('p1', 'a2'))
    expect(names()).toEqual(['a1', 'b1'])
    vi.advanceTimersByTime(200)
    expect(names()).toEqual(['a1', 'b1', 'a2'])
  })

  it('flushes a pending update on request, e.g. before a toast that refers to it', () => {
    broadcaster.projectUpdated(project('p1', 'a1'))
    broadcaster.projectUpdated(project('p1', 'a2'))
    broadcaster.projectUpdated(project('p2', 'b1'))
    broadcaster.projectUpdated(project('p2', 'b2'))
    broadcaster.flushProject('p1')
    expect(names()).toEqual(['a1', 'b1', 'a2'])
    // nothing pending: nothing to send; unknown projects are fine
    broadcaster.flushProject('p1')
    broadcaster.flushProject('nope')
    expect(names()).toEqual(['a1', 'b1', 'a2'])
    vi.advanceTimersByTime(1000)
    expect(names()).toEqual(['a1', 'b1', 'a2', 'b2'])
  })

  it('drops a pending update of a deleted project', () => {
    broadcaster.projectUpdated(project('p1', 'a1'))
    broadcaster.projectUpdated(project('p1', 'a2'))
    broadcaster.projectDeleted('p1')
    vi.advanceTimersByTime(1000)
    expect(names()).toEqual(['a1'])
  })
})

describe('export progress', () => {
  it('limits progress to 8 events per second with a trailing update', () => {
    for (let i = 0; i < 100; i++) {
      broadcaster.exportProgress(progress('rendering', i / 100))
      vi.advanceTimersByTime(10)
    }
    vi.advanceTimersByTime(200)
    const values = phases()
    // 1 s of updates → at most 8 per second plus the leading one
    expect(values.length).toBeLessThanOrEqual(10)
    expect(values.at(-1)).toBe('rendering:0.99')
  })

  it('delivers terminal phases immediately and drops older pending progress', () => {
    broadcaster.exportProgress(progress('rendering', 0.1))
    broadcaster.exportProgress(progress('rendering', 0.5))
    broadcaster.exportProgress(progress('done', 1))
    expect(phases()).toEqual(['rendering:0.1', 'done:1'])
    vi.advanceTimersByTime(1000)
    expect(phases()).toEqual(['rendering:0.1', 'done:1'])
  })

  it('starts fresh for the next export', () => {
    broadcaster.exportProgress(progress('cancelled', 0.3))
    broadcaster.exportProgress(progress('preparing', 0))
    expect(phases()).toEqual(['cancelled:0.3', 'preparing:0'])
  })

  it('sends toasts right away', () => {
    broadcaster.toast({ level: 'success', message: 'Done!' })
    expect(sent).toEqual([
      { channel: IPC_EVENTS.toast, payload: { level: 'success', message: 'Done!' } }
    ])
  })
})

describe('toasts before the renderer is ready', () => {
  it('are held until markReady and then sent in order (only when asked to hold them)', () => {
    const held = new Broadcaster({
      send: (channel, payload) => sent.push({ channel, payload }),
      holdToasts: true
    })
    held.toast({ level: 'warning', message: 'one' })
    held.toast({ level: 'error', message: 'two' })
    held.projectUpdated(project('p1', 'a1'))
    expect(sent.map((s) => s.channel)).toEqual([IPC_EVENTS.projectUpdated])
    held.markReady()
    held.markReady()
    held.toast({ level: 'info', message: 'three' })
    expect(
      sent
        .filter((s) => s.channel === IPC_EVENTS.toast)
        .map((s) => (s.payload as { message: string }).message)
    ).toEqual(['one', 'two', 'three'])
    held.dispose()
  })

  it('are held again while no window is open, until the next window calls in', () => {
    broadcaster.markReady()
    broadcaster.holdToasts()
    broadcaster.toast({ level: 'error', message: 'Export failed' })
    expect(sent).toEqual([])
    broadcaster.markReady()
    expect(sent).toEqual([
      { channel: IPC_EVENTS.toast, payload: { level: 'error', message: 'Export failed' } }
    ])
  })
})
