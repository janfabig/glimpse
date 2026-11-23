// Reversible stand-in for safeStorage so tests never touch the Keychain.

import type { SecretCipher } from '../settings/cipher'
import { createGate, type Gate, type GateControl } from './gate'

type Operation = 'encrypt' | 'decrypt'

export interface FakeCipher extends SecretCipher {
  available: boolean
  /** bump to simulate a key rotation (old ciphertexts decrypt with shouldReEncrypt) */
  generation: number
  /** checked after a held call is released, so a test can flip it while the call waits */
  failDecrypt: boolean
  calls: { encrypt: number; decrypt: number; isAvailable: number }
  /** holds every later call of `operation` until released – like an open Keychain prompt */
  hold(operation: Operation): Gate
}

export function createFakeCipher(): FakeCipher {
  const gates = new Map<Operation, GateControl>()
  const pass = (operation: Operation): Promise<void> | undefined =>
    gates.get(operation)?.pass(undefined, () => new Error('aborted'))

  const cipher: FakeCipher = {
    available: true,
    generation: 1,
    failDecrypt: false,
    calls: { encrypt: 0, decrypt: 0, isAvailable: 0 },
    hold(operation) {
      const gate = createGate()
      gates.set(operation, gate)
      return gate
    },
    async isAvailable() {
      cipher.calls.isAvailable++
      return cipher.available
    },
    async encrypt(plainText) {
      cipher.calls.encrypt++
      const generation = cipher.generation
      await pass('encrypt')
      const scrambled = [...plainText].reverse().join('')
      return Buffer.from(`g${generation}:${scrambled}`, 'utf8')
    },
    async decrypt(data) {
      cipher.calls.decrypt++
      await pass('decrypt')
      if (cipher.failDecrypt) throw new Error('Keychain access denied')
      const match = /^g(\d+):(.*)$/s.exec(data.toString('utf8'))
      if (!match) throw new Error('not encrypted by this cipher')
      return {
        result: [...match[2]].reverse().join(''),
        shouldReEncrypt: Number(match[1]) !== cipher.generation
      }
    }
  }
  return cipher
}
