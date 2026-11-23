import { describe, expect, it } from 'vitest'
import { dittoArgs, zipContents, zipFolder, zipName } from './make-zip.mjs'

describe('make-zip (the zip for friends)', () => {
  it('names the zip after the version in package.json', () => {
    expect(zipName('0.1.0')).toBe('Glimpse-0.1.0.zip')
    expect(zipName('1.12.3-beta.1')).toBe('Glimpse-1.12.3-beta.1.zip')
    // never a path or an empty name
    for (const bad of ['', ' ', '../1.0.0', '1.0/0', undefined]) {
      expect(() => zipName(bad)).toThrow(/version/)
    }
  })

  it('puts exactly the app and the text file into the folder “Glimpse”', () => {
    expect(zipFolder).toBe('Glimpse')
    expect(zipContents('/repo')).toEqual([
      { from: '/repo/dist/mac-arm64/Glimpse.app', name: 'Glimpse.app' },
      { from: '/repo/build/How to open Glimpse.txt', name: 'How to open Glimpse.txt' }
    ])
  })

  it('zips the folder itself with ditto, so the signature and the symlinks survive', () => {
    expect(dittoArgs('/stage/Glimpse', '/repo/dist/Glimpse-0.1.0.zip')).toEqual([
      '-c',
      '-k',
      '--keepParent',
      // no "._" entries next to the app and the text file
      '--norsrc',
      '/stage/Glimpse',
      '/repo/dist/Glimpse-0.1.0.zip'
    ])
  })
})
