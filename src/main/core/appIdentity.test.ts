import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** lets a test make the rename of one entry fail, as a move to another volume would */
const fs = vi.hoisted(() => ({ failRenameOf: '' }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    renameSync: (from: string, to: string): void => {
      if (basename(from) === fs.failRenameOf) throw new Error(`EXDEV: cannot move ${from}`)
      real.renameSync(from, to)
    }
  }
})
import { LEGACY_APP_NAME, moveLegacyUserData, stripDebugSwitches } from './appIdentity'
import { makeTempDir, type TempDir } from './testing/helpers'

function commandLine(switches: string[] = []): {
  removed: string[]
  hasSwitch(name: string): boolean
  removeSwitch(name: string): void
} {
  const removed: string[] = []
  return {
    removed,
    hasSwitch: (name) => switches.includes(name),
    removeSwitch: (name) => void removed.push(name)
  }
}

describe('stripDebugSwitches', () => {
  it('turns remote debugging off in the packaged app', () => {
    const line = commandLine()
    expect(stripDebugSwitches(line, { packaged: true })).toBe(true)
    expect(line.removed).toEqual(['remote-debugging-port', 'remote-debugging-pipe'])
  })

  it('refuses a packaged start with --js-flags (V8 applies it before this runs)', () => {
    const line = commandLine(['js-flags'])
    expect(stripDebugSwitches(line, { packaged: true })).toBe(false)
  })

  it.each(['renderer-cmd-prefix', 'gpu-launcher', 'utility-cmd-prefix', 'browser-subprocess-path'])(
    'refuses a packaged start with --%s (it would run another program as a helper)',
    (name) => {
      expect(stripDebugSwitches(commandLine([name]), { packaged: true })).toBe(false)
    }
  )

  it('keeps them only in the unpackaged app (development, E2E, UI harness)', () => {
    const line = commandLine(['js-flags'])
    expect(stripDebugSwitches(line, { packaged: false })).toBe(true)
    expect(line.removed).toEqual([])
  })
})

describe('moveLegacyUserData', () => {
  let temp: TempDir
  let legacy: string
  let userData: string
  beforeEach(async () => {
    temp = await makeTempDir()
    legacy = join(temp.path, LEGACY_APP_NAME)
    userData = join(temp.path, 'Glimpse')
  })
  afterEach(async () => {
    fs.failRenameOf = ''
    await temp.cleanup()
  })

  /** the data folder of the app's former name, as a user of it has it */
  async function legacyProfile(): Promise<void> {
    await mkdir(join(legacy, 'projects', 'p1'), { recursive: true })
    await writeFile(join(legacy, 'projects', 'p1', 'project.json'), '{"id":"p1"}')
    await writeFile(join(legacy, 'settings.json'), '{"exportDir":"/x"}')
    await writeFile(join(legacy, 'gemini-key.bin'), 'encrypted with the old Keychain entry')
    await writeFile(join(legacy, 'Local State'), 'old')
  }

  it('moves the projects and settings into the Glimpse folder Electron has just created', async () => {
    await legacyProfile()
    // Electron creates these before main runs
    await mkdir(join(userData, 'GPUPersistentCache'), { recursive: true })
    await writeFile(join(userData, 'Local State'), 'new')

    expect(moveLegacyUserData(userData)).toBe(true)

    expect(await readFile(join(userData, 'projects', 'p1', 'project.json'), 'utf8')).toBe(
      '{"id":"p1"}'
    )
    expect(await readFile(join(userData, 'settings.json'), 'utf8')).toBe('{"exportDir":"/x"}')
    expect(await readFile(join(userData, 'Local State'), 'utf8')).toBe('new')
    // only the old Keychain entry could decrypt it: the user enters the key once more
    expect(existsSync(join(userData, 'gemini-key.bin'))).toBe(false)
    expect(existsSync(legacy)).toBe(false)
  })

  it('creates the Glimpse folder when it does not exist yet', async () => {
    await legacyProfile()
    expect(moveLegacyUserData(userData)).toBe(true)
    expect(existsSync(join(userData, 'projects', 'p1', 'project.json'))).toBe(true)
  })

  it('does nothing without a folder of the former name', () => {
    expect(moveLegacyUserData(userData)).toBe(false)
    expect(existsSync(userData)).toBe(false)
  })

  it('points the media paths stored in project files at the new folder', async () => {
    await legacyProfile()
    const proxy = (root: string): string => join(root, 'projects', 'p1', 'media', 'v1', 'proxy.mp4')
    const project = JSON.stringify({ id: 'p1', videos: [{ proxyPath: proxy(legacy) }] })
    await writeFile(join(legacy, 'projects', 'p1', 'project.json'), project)
    await writeFile(join(legacy, 'projects', 'p1', 'project.json.bak'), project)

    expect(moveLegacyUserData(userData)).toBe(true)

    for (const file of ['project.json', 'project.json.bak']) {
      const moved = JSON.parse(await readFile(join(userData, 'projects', 'p1', file), 'utf8'))
      expect(moved.videos[0].proxyPath).toBe(proxy(userData))
    }
  })

  it('waits while the app of the former name is still running', async () => {
    await legacyProfile()
    // Chromium's single-instance lock: a symlink to "<host>-<pid>"
    await symlink(`host-${process.pid}`, join(legacy, 'SingletonLock'))

    expect(moveLegacyUserData(userData)).toBe(false)
    expect(existsSync(join(legacy, 'projects', 'p1', 'project.json'))).toBe(true)
  })

  it('moves after the app of the former name has quit, without its lock', async () => {
    await legacyProfile()
    await symlink('host-999999999', join(legacy, 'SingletonLock'))

    expect(moveLegacyUserData(userData)).toBe(true)
    // existsSync follows the dangling link: list the folder instead
    expect(await readdir(userData)).not.toContain('SingletonLock')
  })

  it('moves the projects first: when that fails nothing has moved and the next start retries', async () => {
    await legacyProfile()
    fs.failRenameOf = 'projects'

    expect(() => moveLegacyUserData(userData)).toThrow('EXDEV')
    expect(existsSync(join(legacy, 'settings.json'))).toBe(true)
    expect(existsSync(join(userData, 'settings.json'))).toBe(false)
  })

  it('never mixes two profiles: a Glimpse folder in use keeps the old folder where it is', async () => {
    await legacyProfile()
    await mkdir(userData)
    await writeFile(join(userData, 'settings.json'), '{}')

    expect(moveLegacyUserData(userData)).toBe(false)
    expect(existsSync(join(legacy, 'projects', 'p1', 'project.json'))).toBe(true)
    expect(existsSync(join(userData, 'projects'))).toBe(false)
  })
})
