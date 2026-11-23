/** Encryption backend for the API key (Electron: async safeStorage = macOS Keychain). */
export interface SecretCipher {
  isAvailable(): Promise<boolean>
  encrypt(plainText: string): Promise<Buffer>
  /** `shouldReEncrypt`: the backend rotated its key – store a fresh encryption of `result` */
  decrypt(data: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}
