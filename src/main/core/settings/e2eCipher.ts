// HC_E2E=1 only: automated runs must never touch the macOS Keychain (a prompt would block them).
// AES-256-GCM with a key derived from the (temporary) test profile – still never plaintext on disk.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { SecretCipher } from './cipher'

const IV_BYTES = 12
const TAG_BYTES = 16

export function createE2eCipher(profileDir: string): SecretCipher {
  const key = createHash('sha256').update(`glimpse-e2e:${profileDir}`).digest()
  return {
    isAvailable: async () => true,
    encrypt: async (plainText) => {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decrypt: async (data) => {
      const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, IV_BYTES))
      decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
      const body = data.subarray(IV_BYTES + TAG_BYTES)
      const result = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
      return { result, shouldReEncrypt: false }
    }
  }
}
