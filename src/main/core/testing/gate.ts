// A gate holds every operation that reaches it until the test releases it (or the caller aborts).

import { deferred } from '../deferred'

export interface Gate {
  /** resolves when the first operation arrives at the gate */
  reached: Promise<void>
  /** operations currently waiting */
  readonly waiting: number
  release(): void
}

export interface GateControl extends Gate {
  /** waits at the gate; rejects with `onAbort()` when the signal aborts */
  pass(signal: AbortSignal | undefined, onAbort: () => Error): Promise<void>
}

export function createGate(): GateControl {
  const reached = deferred<void>()
  const released = deferred<void>()
  let waiting = 0
  let open = false
  return {
    reached: reached.promise,
    get waiting() {
      return waiting
    },
    release() {
      open = true
      released.resolve()
    },
    async pass(signal, onAbort) {
      reached.resolve()
      if (open) return
      if (signal?.aborted) throw onAbort()
      waiting++
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => reject(onAbort())
          signal?.addEventListener('abort', abort, { once: true })
          void released.promise.then(() => {
            signal?.removeEventListener('abort', abort)
            resolve()
          })
        })
      } finally {
        waiting--
      }
    }
  }
}
