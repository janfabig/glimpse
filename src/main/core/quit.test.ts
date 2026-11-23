import { describe, expect, it } from 'vitest'
import { quitStep, type QuitState } from './quit'

/** ⌘Q while an analysis or an export runs, nothing decided yet */
const busy: QuitState = {
  ready: false,
  confirmed: false,
  system: false,
  asking: false,
  e2e: false,
  unfinishedWork: true
}

describe('quitStep', () => {
  it('asks while an analysis or an export runs', () => {
    expect(quitStep(busy)).toBe('ask')
  })

  it('does not ask twice: a second ⌘Q waits for the open question', () => {
    expect(quitStep({ ...busy, asking: true })).toBe('wait')
  })

  it('shuts down without a question when nothing would be lost', () => {
    expect(quitStep({ ...busy, unfinishedWork: false })).toBe('shutdown')
  })

  it('shuts down after "Quit", on logout or restart, and in E2E runs', () => {
    expect(quitStep({ ...busy, confirmed: true })).toBe('shutdown')
    expect(quitStep({ ...busy, system: true })).toBe('shutdown')
    expect(quitStep({ ...busy, e2e: true })).toBe('shutdown')
    // "Quit" was chosen in the question that is still closing
    expect(quitStep({ ...busy, confirmed: true, asking: true })).toBe('shutdown')
  })

  it('lets the app quit once the shutdown is through, whatever else is set', () => {
    expect(quitStep({ ...busy, ready: true })).toBe('quit')
    expect(quitStep({ ...busy, ready: true, asking: true })).toBe('quit')
  })
})
