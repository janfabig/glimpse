/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS script */
// Checks a packaged Glimpse.app against the electronFuses block in electron-builder.yml,
// without showing anything on the desktop:
//
//   node build/verify-package.mjs ["<folder>/Glimpse.app"] [options]
//
//   app            default: dist/mac-arm64/Glimpse.app (read and started, never changed)
//   --static-only  only checks 1–4, the app is not started
//   --tmp-dir      parent folder for temporary profiles (default: OS temp folder)
//   --keep         keep the temporary folders (for debugging)
//
// 1. fuse wire: the values in EXPECTED_FUSES
// 2. asar integrity data, as Electron checks it at start and on every read: Info.plist's
//    ElectronAsarIntegrity hash is the sha256 of the app.asar header, and every file matches the
//    hash and block hashes the header lists for it
// 3. signature: a valid ad-hoc signature over the whole bundle (codesign --verify --deep --strict),
//    the hardened runtime on the app and every helper app, and exactly the entitlements of
//    build/entitlements.mac.plist (allow-jit, allow-unsigned-executable-memory,
//    disable-library-validation)
// 4. ffmpeg inside the app (Contents/Resources/ffmpeg): ffmpeg and ffprobe are there, executable,
//    start and are the pinned version, each carries a valid signature, the licence and SOURCE.txt
//    are there, and the app's signature seals all four files
// 5. start: a hidden start (HC_E2E=1, fresh profile, fake Gemini, the PATH a Finder start gets)
//    reaches body[data-ready="true"] with the app's own ffmpeg working, and the
//    --remote-debugging-port it was given opens no DevTools endpoint (the packaged app strips it,
//    HC_E2E or not). A packaged E2E start logs "[app] ui ready" with its ffmpeg status: that line
//    is how this script sees the start (no CDP, and the inspector fuse is off).
// 6. probes: none of these may run code in the app – ELECTRON_RUN_AS_NODE, NODE_OPTIONS,
//    --inspect, SIGUSR1 (with the inspector fuse off, the signal just ends the app – no crash),
//    DYLD_INSERT_LIBRARIES (a library built here with the command line tools; it writes a marker
//    and ends the process at once, so nothing is shown – skipped without the tools).
//
// A modified app.asar is not started: Electron refuses it with a crash, and macOS then shows a
// "quit unexpectedly" dialog. Checks 1 and 2 cover it statically. OnlyLoadAppFromAsar is only
// checked in the fuse wire: a probe would leave Electron without a loadable app (error dialog).
//
// Only processes started here are stopped. Exit code 1 if a check fails.

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { FFMPEG_VERSION } from '../scripts/fetch-ffmpeg.mjs'

const exec = promisify(execFile)
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// @electron/asar ships with electron-builder (via app-builder-lib)
const requireFromHere = createRequire(import.meta.url)
const requireFromBuilder = createRequire(requireFromHere.resolve('electron-builder/package.json'))
const asar = createRequire(requireFromBuilder.resolve('app-builder-lib/package.json'))(
  '@electron/asar'
)

/** fuse order of the V1 wire in the Electron Framework binary */
const FUSE_NAMES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges'
]
/** what electron-builder.yml sets (LoadBrowserProcessSpecificV8Snapshot, newer fuses: default) */
const EXPECTED_FUSES = {
  RunAsNode: false,
  EnableCookieEncryption: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  GrantFileProtocolExtraPrivileges: true
}
const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
const FUSE_STATES = { 48: 'off', 49: 'on', 114: 'removed' }

const START_TIMEOUT = 60_000
const PROBE_CODE = (marker) => `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`
/** loaded through DYLD_INSERT_LIBRARIES: writes $MARKER and leaves before Electron shows anything */
const INJECT_C = `#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
__attribute__((constructor)) static void probe(void) {
  const char *marker = getenv("MARKER");
  if (!marker) return;
  FILE *f = fopen(marker, "w");
  if (f) { fputs("ran", f); fclose(f); }
  _exit(0);
}
`

// ---------------------------------------------------------------------------------------------
// arguments

const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  if (at < 0) return false
  args.splice(at, 1)
  return true
}
const option = (name) => {
  const at = args.indexOf(name)
  if (at < 0) return undefined
  const [, value] = args.splice(at, 2)
  if (!value) throw new Error(`${name} needs a value`)
  return value
}
const KEEP = flag('--keep')
const STATIC_ONLY = flag('--static-only')
const TMP_PARENT = resolve(option('--tmp-dir') ?? tmpdir())
const BINARY = (app) => join(app, 'Contents/MacOS/Glimpse')
const requested = resolve(args[0] ?? join(REPO, 'dist/mac-arm64/Glimpse.app'))
if (!existsSync(BINARY(requested))) {
  console.error(
    `No packaged app at ${requested} – run npm run package first or pass the .app path.`
  )
  process.exit(2)
}
// helper processes show the real path in their command line
const APP = await realpath(requested)

// ---------------------------------------------------------------------------------------------
// helpers

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function until(predicate, timeout, interval = 150) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await predicate()) return true
    await sleep(interval)
  }
  return predicate()
}

async function freePort() {
  const server = createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  await new Promise((done) => server.close(done))
  return port
}

function isListening(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      done(true)
    })
    socket.once('error', () => done(false))
  })
}

/** evaluates `expression` in the main process through a Node inspector on `port` */
async function evaluateOverInspector(port, expression) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl)
  await new Promise((done, fail) => {
    socket.onopen = done
    socket.onerror = () => fail(new Error('inspector connection failed'))
  })
  const reply = new Promise((done) => {
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id === 1) done(message)
    }
  })
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression } }))
  const result = await Promise.race([reply, sleep(10_000)])
  socket.close()
  return result
}

/** environment of every start: hidden window, isolated profile, fake Gemini, Finder's PATH */
function appEnv(root, extra = {}) {
  const env = {
    HOME: process.env.HOME,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    // what a start from the Finder gets: no Homebrew – the app has to find ffmpeg by itself
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HC_E2E: '1',
    HC_FAKE_AI: '1',
    HC_USER_DATA_DIR: join(root, 'profile'),
    HC_OUTPUT_DIR: join(root, 'exports'),
    ...extra
  }
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined))
}

/** process ids below `pid`, with their command lines */
async function descendants(pid) {
  const { stdout } = await exec('/bin/ps', ['-axww', '-o', 'pid=,ppid=,command='])
  const rows = stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, child, parent, command]) => ({ pid: +child, ppid: +parent, command }))
  const found = []
  const queue = [pid]
  while (queue.length > 0) {
    const parent = queue.shift()
    for (const row of rows.filter((candidate) => candidate.ppid === parent)) {
      found.push(row)
      queue.push(row.pid)
    }
  }
  return found
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** starts the app binary of `app` (never through LaunchServices, so the child is ours) */
function launch(app, { root, args: appArgs = [], env = {} }) {
  const child = spawn(BINARY(app), appArgs, {
    env: appEnv(root, env),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const proc = {
    child,
    output: '',
    exit: null,
    helpers: [],
    get exited() {
      return proc.exit !== null
    },
    async rememberHelpers() {
      if (proc.exited) return
      const found = await descendants(child.pid)
      const known = new Set(proc.helpers.map((helper) => helper.pid))
      proc.helpers.push(...found.filter((helper) => !known.has(helper.pid)))
    },
    /** SIGTERM (the app quits normally), SIGKILL after 15 s, then leftover helper processes */
    async stop() {
      await proc.rememberHelpers()
      if (!proc.exited) {
        child.kill('SIGTERM')
        if (!(await until(() => proc.exited, 15_000))) child.kill('SIGKILL')
        await until(() => proc.exited, 5_000)
      }
      await sleep(500)
      // only processes this run started that still run from this app bundle or temp folder
      for (const helper of proc.helpers) {
        const ours = helper.command.includes(app) || helper.command.includes(root)
        if (ours && alive(helper.pid)) process.kill(helper.pid, 'SIGKILL')
      }
    }
  }
  child.stdout.on('data', (chunk) => (proc.output += chunk))
  child.stderr.on('data', (chunk) => (proc.output += chunk))
  child.on('exit', (code, signal) => (proc.exit = { code, signal }))
  child.on('error', (err) => (proc.exit = { code: null, signal: null, error: err.message }))
  return proc
}

/** waits for the app's "[app] ui ready" log line (the UI has loaded its data) and returns its data */
async function waitForReadyUi(proc, timeout = START_TIMEOUT) {
  const ready = () => /\[app\] ui ready (\{.*\})$/m.exec(proc.output)?.[1]
  await until(() => ready() || proc.exited, timeout)
  if (!ready()) throw new Error(`the UI did not get ready (${describeExit(proc)})`)
  await proc.rememberHelpers()
  return { info: JSON.parse(ready()) }
}

/** resolves true once the UI is ready, false if the app exits or `marker` appears first */
async function readyOrStopped(proc, marker, timeout = START_TIMEOUT) {
  let settled = false
  const ready = waitForReadyUi(proc, timeout).then(
    () => true,
    () => false
  )
  const stopped = until(() => settled || proc.exited || existsSync(marker), timeout).then(
    () => false
  )
  const result = await Promise.race([ready, stopped])
  settled = true
  return result
}

function describeExit(proc) {
  if (!proc.exit) return 'still running'
  if (proc.exit.error) return `could not start: ${proc.exit.error}`
  return proc.exit.signal ? `ended by ${proc.exit.signal}` : `exit code ${proc.exit.code}`
}

async function newRoot(name) {
  const root = await mkdtemp(join(TMP_PARENT, `hc-verify-${name}-`))
  await mkdir(join(root, 'exports'), { recursive: true })
  return root
}

// ---------------------------------------------------------------------------------------------
// checks: each returns { ok, detail }

async function checkFuses() {
  const binary = join(APP, 'Contents/Frameworks/Electron Framework.framework/Electron Framework')
  const bytes = await readFile(binary)
  const at = bytes.indexOf(FUSE_SENTINEL)
  if (at < 0) return { ok: false, detail: 'no fuse wire found in Electron Framework' }
  const wire = at + FUSE_SENTINEL.length
  const [version, length] = [bytes[wire], bytes[wire + 1]]
  if (version !== 1) return { ok: false, detail: `unknown fuse wire version ${version}` }
  const states = Array.from({ length }, (_, i) => FUSE_STATES[bytes[wire + 2 + i]] ?? '?')
  const wrong = Object.entries(EXPECTED_FUSES)
    .filter(([name, on]) => states[FUSE_NAMES.indexOf(name)] !== (on ? 'on' : 'off'))
    .map(([name]) => name)
  const listed = states.map((state, i) => `${FUSE_NAMES[i] ?? `#${i}`}=${state}`).join(' ')
  return { ok: wrong.length === 0, detail: wrong.length ? `wrong: ${wrong.join(', ')}` : listed }
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/** block hashes the way @electron/asar lists them: full blocks, then the (maybe empty) rest */
function blockHashes(content, blockSize) {
  const hashes = []
  let at = 0
  for (; at + blockSize <= content.length; at += blockSize) {
    hashes.push(sha256(content.subarray(at, at + blockSize)))
  }
  hashes.push(sha256(content.subarray(at)))
  return hashes
}

/** what Electron checks at start (header hash) and on every read (file hashes), done statically */
async function checkAsarIntegrity() {
  const archive = join(APP, 'Contents/Resources/app.asar')
  const plist = join(APP, 'Contents/Info.plist')
  const { stdout } = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist])
  const expected = JSON.parse(stdout).ElectronAsarIntegrity?.['Resources/app.asar']
  if (!expected) return { ok: false, detail: 'no ElectronAsarIntegrity entry for app.asar' }
  const { header, headerString, headerSize } = asar.getRawHeader(archive)
  const problems = []
  if (expected.algorithm !== 'SHA256' || expected.hash !== sha256(headerString)) {
    problems.push('the header does not match its hash in Info.plist')
  }
  const bytes = await readFile(archive)
  const dataStart = 8 + headerSize
  let checked = 0
  const visit = async (node, path) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const file = `${path}${name}`
      if (entry.files) {
        await visit(entry, `${file}/`)
        continue
      }
      if (entry.link) continue
      const { integrity } = entry
      if (!integrity?.blocks?.length) {
        problems.push(`${file} has no block hashes`)
        continue
      }
      const offset = dataStart + Number(entry.offset ?? 0)
      const content = entry.unpacked
        ? await readFile(join(`${archive}.unpacked`, file))
        : bytes.subarray(offset, offset + entry.size)
      const blocks = blockHashes(content, integrity.blockSize)
      if (sha256(content) !== integrity.hash || blocks.join() !== integrity.blocks.join()) {
        problems.push(`${file} does not match its hashes`)
      }
      checked++
    }
  }
  await visit(header, '')
  return {
    ok: problems.length === 0,
    detail: problems.length
      ? problems.slice(0, 3).join('; ')
      : `header and ${checked} files match (header sha256 ${expected.hash.slice(0, 12)}…)`
  }
}

/**
 * exactly these (sorted): any other entitlement widens the hardened runtime, e.g.
 * allow-dyld-environment-variables (library injection) or get-task-allow (a debugger may attach)
 */
const ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation'
]

async function checkSignature() {
  try {
    await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', APP])
  } catch (err) {
    return { ok: false, detail: `codesign --verify: ${String(err.stderr || err.message).trim()}` }
  }
  const { stderr } = await exec('/usr/bin/codesign', ['-dv', '--verbose=4', APP])
  const field = (name) => new RegExp(`^${name}=(.*)$`, 'm').exec(stderr)?.[1]?.trim()
  const flags = /^CodeDirectory .*flags=(\S+)/m.exec(stderr)?.[1] ?? '?'
  const adHoc = field('Signature') === 'adhoc' && !flags.includes('linker-signed')
  const sealed = /^Sealed Resources version=/m.test(stderr)
  const plistBound = field('Info.plist') !== 'not bound'
  // without the hardened runtime (or with allow-dyld-environment-variables) dyld loads any library
  // named in DYLD_INSERT_LIBRARIES into the process that decrypts the API key
  const frameworks = join(APP, 'Contents/Frameworks')
  const helpers = (await readdir(frameworks)).filter((name) => name.endsWith('.app'))
  const unhardened = []
  for (const bundle of [APP, ...helpers.map((name) => join(frameworks, name))]) {
    const { stderr: info } = await exec('/usr/bin/codesign', ['-dv', '--verbose=4', bundle])
    const { stdout: entitlements } = await exec('/usr/bin/codesign', [
      '-d',
      '--entitlements',
      '-',
      '--xml',
      bundle
    ])
    const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]).sort()
    const hardened =
      /^CodeDirectory .*flags=\S*\bruntime\b/m.test(info) && keys.join() === ENTITLEMENTS.join()
    if (!hardened) unhardened.push(bundle === APP ? 'the app' : basename(bundle))
  }
  const detail = [
    `Signature=${field('Signature')}`,
    `flags=${flags}`,
    `CDHash=${field('CDHash')}`,
    `sealed resources=${sealed}`,
    `Info.plist bound=${plistBound}`,
    unhardened.length
      ? `not hardened (runtime flag, entitlements): ${unhardened.join(', ')}`
      : `hardened runtime on the app and ${helpers.length} helpers`
  ]
  return { ok: adHoc && sealed && plistBound && unhardened.length === 0, detail: detail.join(' ') }
}

/** the ffmpeg the app carries; the packaged app uses no other (src/main/media/toolchain.ts) */
const FFMPEG_DIR = join(APP, 'Contents/Resources/ffmpeg')

async function checkFfmpeg() {
  const firstLine = (err) =>
    String(err.stderr || err.message)
      .trim()
      .split('\n')[0]
  const problems = []
  for (const name of ['ffmpeg', 'ffprobe']) {
    const binary = join(FFMPEG_DIR, name)
    try {
      await access(binary, constants.X_OK)
    } catch {
      problems.push(`${name} is missing or not executable (run node scripts/fetch-ffmpeg.mjs)`)
      continue
    }
    try {
      const { stdout } = await exec(binary, ['-version'])
      const version = new RegExp(`^${name} version (\\S+)`).exec(stdout)?.[1]
      // the build appends its maker's address: "9.0.2-https://www.martin-riedl.de"
      if (version !== FFMPEG_VERSION && !version?.startsWith(`${FFMPEG_VERSION}-https://`)) {
        problems.push(`${name} is version ${version ?? '?'}, not ${FFMPEG_VERSION}`)
      }
    } catch (err) {
      problems.push(`${name} does not start: ${firstLine(err)}`)
    }
    try {
      await exec('/usr/bin/codesign', ['--verify', '--strict', binary])
    } catch (err) {
      problems.push(`${name}: codesign --verify: ${firstLine(err)}`)
    }
  }
  const licence = await readFile(join(FFMPEG_DIR, 'LICENSE-FFMPEG.txt'), 'utf8').catch(() => '')
  if (!licence.includes('GNU GENERAL PUBLIC LICENSE'))
    problems.push('LICENSE-FFMPEG.txt is missing')
  if (!existsSync(join(FFMPEG_DIR, 'SOURCE.txt'))) problems.push('SOURCE.txt is missing')
  // the bundle's seal: a changed or swapped file breaks the app's signature
  const seal = await readFile(join(APP, 'Contents/_CodeSignature/CodeResources'), 'utf8').catch(
    () => ''
  )
  const unsealed = ['ffmpeg', 'ffprobe', 'LICENSE-FFMPEG.txt', 'SOURCE.txt'].filter(
    (name) => !seal.includes(`<key>Resources/ffmpeg/${name}</key>`)
  )
  if (unsealed.length) problems.push(`not sealed by the app's signature: ${unsealed.join(', ')}`)
  return {
    ok: problems.length === 0,
    detail: problems.length
      ? problems.join('; ')
      : `ffmpeg and ffprobe ${FFMPEG_VERSION}, signed and sealed, with the licence`
  }
}

async function checkHiddenStart() {
  const root = await newRoot('start')
  const proc = launch(APP, { root, args: ['--remote-debugging-port=0'] })
  try {
    const started = Date.now()
    const { info } = await waitForReadyUi(proc)
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    if (proc.output.includes('DevTools listening')) {
      return { ok: false, detail: '--remote-debugging-port opened a DevTools endpoint' }
    }
    // its own copy, not one that happens to be installed on this Mac
    const own = info.ffmpeg.ffmpegPath === join(FFMPEG_DIR, 'ffmpeg')
    const ffmpeg = !info.ffmpeg.ok
      ? 'ffmpeg not found'
      : own
        ? `its own ffmpeg ${info.ffmpeg.version}`
        : `ffmpeg from outside the app: ${info.ffmpeg.ffmpegPath}`
    return {
      ok: info.ffmpeg.ok && own,
      detail: `ready after ${seconds} s, ${ffmpeg}, no DevTools endpoint`
    }
  } catch (err) {
    return { ok: false, detail: `${err.message.split('\n')[0]} (${describeExit(proc)})` }
  } finally {
    await proc.stop()
    if (!KEEP) await rm(root, { recursive: true, force: true })
  }
}

/** the app's own start-up ran (its first log line) – a Node snippet would have run before */
const startedAsApp = (proc) => proc.output.includes('[app] starting')

async function probeRunAsNode() {
  const root = await newRoot('run-as-node')
  const marker = join(root, 'marker')
  const proc = launch(APP, {
    root,
    args: ['-e', PROBE_CODE(marker)],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  })
  try {
    await until(() => existsSync(marker) || proc.exited || startedAsApp(proc), 20_000)
    await sleep(1000)
    const ran = existsSync(marker)
    return {
      ok: !ran,
      detail: ran ? 'ELECTRON_RUN_AS_NODE=1 ran a Node snippet' : 'ignored, started as the app'
    }
  } finally {
    await proc.stop()
    if (!KEEP) await rm(root, { recursive: true, force: true })
  }
}

async function probeNodeOptions() {
  const root = await newRoot('node-options')
  const marker = join(root, 'marker')
  const preload = join(root, 'preload.cjs')
  await writeFile(preload, `${PROBE_CODE(marker)}\n`)
  const env = {
    NODE_OPTIONS: `--require "${preload}"`,
    NODE_EXTRA_CA_CERTS: join(root, 'extra-ca.pem'),
    ELECTRON_ENABLE_LOGGING: '1'
  }
  const ran = []
  let ignored = false
  try {
    // as an app start and together with ELECTRON_RUN_AS_NODE (Node honours NODE_OPTIONS there)
    for (const [label, extra, appArgs] of [
      ['app start', {}, []],
      ['with ELECTRON_RUN_AS_NODE', { ELECTRON_RUN_AS_NODE: '1' }, ['-e', '0']]
    ]) {
      const proc = launch(APP, { root, args: appArgs, env: { ...env, ...extra } })
      try {
        if (appArgs[0] === '-e') {
          await until(() => existsSync(marker) || proc.exited || startedAsApp(proc), 20_000)
        } else {
          await readyOrStopped(proc, marker)
        }
        await sleep(500)
        if (existsSync(marker)) ran.push(label)
        ignored ||= proc.output.includes('ignored due to disabled nodeOptions fuse')
      } finally {
        await proc.stop()
      }
    }
    const note = ignored ? ' (Electron: ignored due to disabled nodeOptions fuse)' : ''
    return {
      ok: ran.length === 0,
      detail: ran.length ? `--require ran (${ran.join(', ')})` : `--require did not run${note}`
    }
  } finally {
    if (!KEEP) await rm(root, { recursive: true, force: true })
  }
}

const WRITE_MARKER_IN_MAIN = (marker) =>
  `process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`

async function probeInspectArgument() {
  const root = await newRoot('inspect')
  const marker = join(root, 'marker')
  const port = await freePort()
  const proc = launch(APP, { root, args: [`--inspect=${port}`] })
  try {
    if (!(await readyOrStopped(proc, marker))) {
      return { ok: false, detail: `the app did not start (${describeExit(proc)})` }
    }
    if (!(await isListening(port))) return { ok: true, detail: `no inspector on port ${port}` }
    await evaluateOverInspector(port, WRITE_MARKER_IN_MAIN(marker))
    const ran = existsSync(marker)
    return { ok: false, detail: `inspector on port ${port}${ran ? ', code ran in main' : ''}` }
  } finally {
    await proc.stop()
    if (!KEEP) await rm(root, { recursive: true, force: true })
  }
}

/** SIGUSR1 starts Node's inspector on port 9229 unless the inspect fuse is off */
async function probeSigusr1() {
  if (await isListening(9229)) return { ok: true, detail: 'skipped: port 9229 is in use' }
  const root = await newRoot('sigusr1')
  const marker = join(root, 'marker')
  const proc = launch(APP, { root })
  try {
    if (!(await readyOrStopped(proc, marker))) {
      return { ok: false, detail: `the app did not start (${describeExit(proc)})` }
    }
    proc.child.kill('SIGUSR1')
    await until(() => isListening(9229), 3000, 250)
    if (!(await isListening(9229))) {
      const state = proc.exited ? `the app ${describeExit(proc)}` : 'the app kept running'
      return { ok: true, detail: `no inspector on port 9229, ${state}` }
    }
    await evaluateOverInspector(9229, WRITE_MARKER_IN_MAIN(marker))
    const ran = existsSync(marker)
    return { ok: false, detail: `inspector on port 9229${ran ? ', code ran in main' : ''}` }
  } finally {
    await proc.stop()
    if (!KEEP) await rm(root, { recursive: true, force: true })
  }
}

/** the hardened runtime must make dyld ignore DYLD_INSERT_LIBRARIES (helpers inherit it too) */
async function probeDyldInsert() {
  // the stub /usr/bin/cc would offer to install the command line tools in a dialog
  const tools = await exec('/usr/bin/xcode-select', ['-p']).then(
    ({ stdout }) => existsSync(stdout.trim()),
    () => false
  )
  if (!tools) return { ok: true, detail: 'skipped: no command line tools (check 3 covers it)' }
  const root = await newRoot('dyld')
  const marker = join(root, 'marker')
  const library = join(root, 'inject.dylib')
  try {
    await writeFile(join(root, 'inject.c'), INJECT_C)
    await exec('/usr/bin/cc', ['-dynamiclib', '-o', library, join(root, 'inject.c')])
    const proc = launch(APP, {
      root,
      env: { DYLD_INSERT_LIBRARIES: library, MARKER: marker }
    })
    try {
      const ready = await readyOrStopped(proc, marker)
      const ran = existsSync(marker)
      if (ran) return { ok: false, detail: 'the injected library ran in the app' }
      return ready
        ? { ok: true, detail: 'ignored, the app started without the library' }
        : { ok: false, detail: `the app did not start (${describeExit(proc)})` }
    } finally {
      await proc.stop()
    }
  } finally {
    if (!KEEP) await rm(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------

const CHECKS = [
  ['fuse wire', checkFuses],
  ['asar integrity data', checkAsarIntegrity],
  ['ad-hoc signature', checkSignature],
  ['ffmpeg inside the app', checkFfmpeg],
  ...(STATIC_ONLY
    ? []
    : [
        ['hidden start', checkHiddenStart],
        ['ELECTRON_RUN_AS_NODE', probeRunAsNode],
        ['NODE_OPTIONS', probeNodeOptions],
        ['--inspect', probeInspectArgument],
        ['SIGUSR1', probeSigusr1],
        ['DYLD_INSERT_LIBRARIES', probeDyldInsert]
      ])
]

console.log(`Checking ${APP}\n`)
if (STATIC_ONLY) console.log('(static checks only – the app is not started)\n')
let failed = 0
for (const [name, check] of CHECKS) {
  let result
  try {
    result = await check()
  } catch (err) {
    result = { ok: false, detail: `check failed: ${err.message.split('\n')[0]}` }
  }
  if (!result.ok) failed++
  console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(26)} ${result.detail}`)
}
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.')
process.exit(failed ? 1 : 0)
