import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/**
 * The app's name everywhere: menu, window title, About panel, texts, the app file Glimpse.app.
 * Electron builds the data folder (~/Library/Application Support/Glimpse) and the Keychain entry of
 * the API key ("Glimpse Safe Storage") from it. package.json's productName is the same name (Electron
 * uses it until main runs).
 */
export const APP_NAME = 'Glimpse'

/** the app's former name: only its data folder is still looked for, once, by moveLegacyUserData */
export const LEGACY_APP_NAME = 'Highlight Cutter'

/** written only by the app itself: one of them in the Glimpse folder means it is in use */
const APP_DATA_ENTRIES = ['settings.json', 'gemini-key.bin', 'projects', 'logs']

/**
 * Moves the data folder of the app's former name (projects, settings, logs) into the Glimpse
 * folder, once. Electron has already created the Glimpse folder with its own caches when main runs,
 * so the entries move one by one and Electron's fresh ones stay. The stored API key is dropped: only
 * the former name's Keychain entry can decrypt it, so the user enters the key once more.
 * Returns true when it moved something.
 */
export function moveLegacyUserData(userData: string): boolean {
  const legacy = join(dirname(userData), LEGACY_APP_NAME)
  if (!existsSync(legacy)) return false
  if (APP_DATA_ENTRIES.some((name) => existsSync(join(userData, name)))) return false
  // moving its folder away would make every later save of the running old app fail
  if (isRunning(legacy)) return false
  mkdirSync(userData, { recursive: true })
  // projects first: if that fails, nothing has moved and the guard above lets the next start retry
  const entries = readdirSync(legacy)
  for (const name of ['projects', ...entries.filter((entry) => entry !== 'projects')]) {
    if (!entries.includes(name) || name === 'gemini-key.bin' || name.startsWith('Singleton'))
      continue
    if (existsSync(join(userData, name))) continue
    renameSync(join(legacy, name), join(userData, name))
  }
  rebaseProjectPaths(join(legacy, 'projects'), join(userData, 'projects'))
  // left: the undecryptable key, Chromium's lock files and old copies of Electron's caches
  rmSync(legacy, { recursive: true, force: true })
  return true
}

/** Chromium's single-instance lock is a symlink to "<host>-<pid>" while the app runs */
function isRunning(profile: string): boolean {
  let pid: number
  try {
    pid = Number(/-(\d+)$/.exec(readlinkSync(join(profile, 'SingletonLock')))?.[1])
  } catch {
    return false
  }
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to someone else
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** project files store absolute media paths (proxy, poster, filmstrip): point them at the new folder */
function rebaseProjectPaths(from: string, to: string): void {
  if (!existsSync(to)) return
  // as the paths appear inside JSON strings
  const escape = (path: string): string => JSON.stringify(path + sep).slice(1, -1)
  for (const id of readdirSync(to)) {
    for (const file of ['project.json', 'project.json.bak']) {
      const path = join(to, id, file)
      if (!existsSync(path)) continue
      const text = readFileSync(path, 'utf8')
      const rebased = text.split(escape(from)).join(escape(to))
      if (rebased !== text) writeFileSync(path, rebased)
    }
  }
}

export interface AppIdentityTarget {
  setName(name: string): void
  setPath(name: 'userData', path: string): void
}

/**
 * Sets the app name and applies HC_USER_DATA_DIR. Must run before anything reads the profile
 * (safeStorage, sessions, our stores) – see core/early.ts.
 * Returns the overridden userData directory, or null when the default is used.
 */
export function applyAppIdentity(app: AppIdentityTarget, env: NodeJS.ProcessEnv): string | null {
  app.setName(APP_NAME)
  const override = env.HC_USER_DATA_DIR?.trim()
  if (!override) return null
  const dir = isAbsolute(override) ? override : resolve(override)
  mkdirSync(dir, { recursive: true })
  app.setPath('userData', dir)
  return dir
}

/**
 * HC_E2E=1 hides the window and stores the API key with a test cipher – on the user's real profile
 * that would overwrite their Keychain-protected key and touch their projects, so it needs an
 * isolated HC_USER_DATA_DIR profile.
 */
export function assertIsolatedE2eProfile(e2e: boolean, userDataOverride: string | null): void {
  if (e2e && !userDataOverride) {
    throw new Error('HC_E2E=1 requires HC_USER_DATA_DIR (an isolated test profile)')
  }
}

const REFUSED_SWITCHES = [
  'js-flags',
  'renderer-cmd-prefix',
  'gpu-launcher',
  'utility-cmd-prefix',
  'browser-subprocess-path'
]

/**
 * Another program could start the packaged app with debug switches: remote debugging drives its
 * window (and window.api) over the DevTools protocol, --js-flags=--trace prints every main-process
 * call with its arguments, the API key included, and the launcher switches run another program as a
 * helper process. Only the unpackaged app (development, E2E, the UI harness) keeps them; HC_E2E=1
 * does not, so build/verify-package.mjs watches a packaged start through its log, not over CDP.
 * Returns false when the start must be refused: V8 applies --js-flags before this runs.
 */
export function stripDebugSwitches(
  commandLine: { hasSwitch(name: string): boolean; removeSwitch(name: string): void },
  { packaged }: { packaged: boolean }
): boolean {
  if (!packaged) return true
  commandLine.removeSwitch('remote-debugging-port')
  commandLine.removeSwitch('remote-debugging-pipe')
  return !REFUSED_SWITCHES.some((name) => commandLine.hasSwitch(name))
}
