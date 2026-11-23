// Electron 45 async safeStorage (the sync API is deprecated and removed in 46).
// Only call after `ready`; the first call may show the macOS Keychain prompt.

import { safeStorage } from 'electron'
import type { SecretCipher } from './cipher'

export const safeStorageCipher: SecretCipher = {
  isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
  encrypt: (plainText) => safeStorage.encryptStringAsync(plainText),
  decrypt: (data) => safeStorage.decryptStringAsync(data)
}
