import { readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_NAME, applyAppIdentity, assertIsolatedE2eProfile } from './appIdentity'
import { createAppPaths, resolveDefaultOutputDir } from './paths'
import { makeTempDir } from './testing/helpers'

describe('createAppPaths', () => {
  const paths = createAppPaths('/Users/demo/Library/Application Support/Glimpse')

  it('follows the documented userData layout', () => {
    const root = '/Users/demo/Library/Application Support/Glimpse'
    expect(paths.settingsFile).toBe(`${root}/settings.json`)
    expect(paths.apiKeyFile).toBe(`${root}/gemini-key.bin`)
    expect(paths.logFile).toBe(`${root}/logs/main.log`)
    expect(paths.projectFile('p1')).toBe(`${root}/projects/p1/project.json`)
    expect(paths.posterFile('p1', 'v1')).toBe(`${root}/projects/p1/media/v1/poster.jpg`)
    expect(paths.proxyFile('p1', 'v1')).toBe(`${root}/projects/p1/media/v1/proxy.mp4`)
    expect(paths.analysisFile('p1', 'v1')).toBe(`${root}/projects/p1/media/v1/analysis.mp4`)
    expect(paths.spriteFile('p1', 'v1')).toBe(`${root}/projects/p1/media/v1/sprite.jpg`)
    expect(paths.exportWorkDir('p1', 'e1')).toBe(`${root}/projects/p1/tmp/export-e1`)
  })

  it('refuses ids that could escape the projects folder', () => {
    for (const id of ['..', '../x', 'a/b', '', 'x'.repeat(65), 'a b']) {
      expect(() => paths.projectDir(id), id).toThrow()
    }
    expect(() => paths.proxyFile('p1', '../../secret')).toThrow()
    expect(() => paths.analysisFile('p1', '../../secret')).toThrow()
  })
})

describe('resolveDefaultOutputDir', () => {
  it('uses ~/Movies/Glimpse unless HC_OUTPUT_DIR is set', () => {
    expect(resolveDefaultOutputDir('/Users/jan/Movies', {})).toBe('/Users/jan/Movies/Glimpse')
    expect(resolveDefaultOutputDir('/Users/jan/Movies', { HC_OUTPUT_DIR: '/tmp/e2e/out/' })).toBe(
      '/tmp/e2e/out'
    )
    expect(resolveDefaultOutputDir('/Users/jan/Movies', { HC_OUTPUT_DIR: 'relative' })).toBe(
      '/Users/jan/Movies/Glimpse'
    )
  })
})

describe('applyAppIdentity', () => {
  it('sets the name and applies HC_USER_DATA_DIR (creating it)', async () => {
    const temp = await makeTempDir()
    try {
      const calls: string[] = []
      const target = join(temp.path, 'profile')
      const dir = applyAppIdentity(
        {
          setName: (name) => calls.push(`name:${name}`),
          setPath: (key, path) => calls.push(`${key}:${path}`)
        },
        { HC_USER_DATA_DIR: ` ${target} ` }
      )
      expect(dir).toBe(target)
      expect(calls).toEqual([`name:${APP_NAME}`, `userData:${target}`])
      expect((await stat(target)).isDirectory()).toBe(true)
    } finally {
      await temp.cleanup()
    }
  })

  it('keeps the default profile without the variable', () => {
    const calls: string[] = []
    expect(
      applyAppIdentity({ setName: (n) => calls.push(n), setPath: () => calls.push('path') }, {})
    ).toBeNull()
    expect(calls).toEqual([APP_NAME])
  })
})

// Electron builds the data folder and the Keychain entry of the API key from the app name
// (ARCHITECTURE §5): both say Glimpse, in development and in the packaged app.
describe('the names Electron derives from the app name', () => {
  /** the name main gives Electron on the real profile */
  function electronName(): string {
    const names: string[] = []
    applyAppIdentity({ setName: (name) => names.push(name), setPath: () => undefined }, {})
    expect(names).toHaveLength(1)
    return names[0]
  }
  const repoFile = (name: string): string => readFileSync(join(__dirname, '../../..', name), 'utf8')

  it('names the data folder ~/Library/Application Support/Glimpse', () => {
    // Electron: userData = appData + app name
    expect(join('/Users/demo/Library/Application Support', electronName())).toBe(
      '/Users/demo/Library/Application Support/Glimpse'
    )
    // the name Electron has before main runs (dev and packaged): package.json, not the bundle
    expect((JSON.parse(repoFile('package.json')) as { productName?: string }).productName).toBe(
      'Glimpse'
    )
  })

  it('names the Keychain entry "Glimpse Safe Storage" of the API key', () => {
    // Electron: Keychain service = app name + ' Safe Storage', account = app name + ' Key'
    expect(`${electronName()} Safe Storage`).toBe('Glimpse Safe Storage')
  })

  it('names the app file and the bundle id after Glimpse', () => {
    expect(APP_NAME).toBe('Glimpse')
    expect(repoFile('electron-builder.yml')).toMatch(/^productName: Glimpse$/m)
    expect(repoFile('electron-builder.yml')).toMatch(/^appId: de\.janfabig\.glimpse$/m)
  })
})

describe('assertIsolatedE2eProfile', () => {
  it('refuses E2E mode on the real profile', () => {
    expect(() => assertIsolatedE2eProfile(true, null)).toThrow(/HC_USER_DATA_DIR/)
    expect(() => assertIsolatedE2eProfile(true, '/tmp/e2e-profile')).not.toThrow()
    expect(() => assertIsolatedE2eProfile(false, null)).not.toThrow()
  })
})
