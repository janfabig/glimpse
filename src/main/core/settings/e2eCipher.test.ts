import { describe, expect, it } from 'vitest'
import { createE2eCipher } from './e2eCipher'

describe('createE2eCipher', () => {
  it('round-trips without exposing the plaintext', async () => {
    const cipher = createE2eCipher('/tmp/profile-a')
    const encrypted = await cipher.encrypt('AIzaSecretKey123')
    expect(encrypted.toString('utf8')).not.toContain('AIzaSecretKey123')
    expect(await cipher.decrypt(encrypted)).toEqual({
      result: 'AIzaSecretKey123',
      shouldReEncrypt: false
    })
    expect(await createE2eCipher('/tmp/profile-a').decrypt(encrypted)).toMatchObject({
      result: 'AIzaSecretKey123'
    })
  })

  it('cannot decrypt data of another profile or tampered data', async () => {
    const encrypted = await createE2eCipher('/tmp/profile-a').encrypt('AIzaSecretKey123')
    await expect(createE2eCipher('/tmp/profile-b').decrypt(encrypted)).rejects.toThrow()
    const tampered = Buffer.from(encrypted)
    tampered[tampered.length - 1] ^= 1
    await expect(createE2eCipher('/tmp/profile-a').decrypt(tampered)).rejects.toThrow()
  })
})
