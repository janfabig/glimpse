# Electron 45 / tooling – verified facts (researched 2026-11-01)

Versions: electron 45.2.3 (Chromium 156.0.8078.80, **Node 24.22.2**), electron-vite 6.0.0, vite 8.3.5,
@vitejs/plugin-react 6.1.2, electron-builder 26.18.0, React 19.3.1, vitest 5.0.5, playwright 1.64.1.
Stay on TypeScript ~5.9 (typescript-eslint does not support TS 7 yet).

## Sandboxed preload (Electron 45)

- With `sandbox: true` the preload can only `require('electron')` (`contextBridge`, `ipcRenderer`,
  `webUtils`). Electron 45 **removed `Buffer`, `setImmediate`, `events`, `timers`, `url`** from sandboxed
  preloads. Everything else must be bundled (`preload.build.externalizeDeps: false`, already configured).
- Drag & drop paths: `webUtils.getPathForFile(file)` in the preload (`File.path` is gone).

## safeStorage

- The sync methods are **deprecated in 45 and removed in 46** → use the async API:
  `await safeStorage.isAsyncEncryptionAvailable()`, `await safeStorage.encryptStringAsync(key)` (Buffer),
  `await safeStorage.decryptStringAsync(buf)` → `{ result, shouldReEncrypt }` (re-encrypt + save when true).
- Persist as base64 in a file with mode `0o600`. Only after `app` is ready.
- Unsigned/ad-hoc builds change code identity on rebuild → macOS may ask once more for Keychain access
  ("Immer erlauben"). Env `GEMINI_API_KEY` is the dev/E2E escape hatch (never touch the Keychain in tests).

## Local media in the renderer

- `protocol.handle` + `net.fetch(pathToFileURL(p))` is **not seekable** (Range → 200 with cut body,
  electron/electron#38749) → hand-written handler returning 206 + `Content-Range` + `Accept-Ranges` +
  `Content-Length`, body `Readable.toWeb(fs.createReadStream(p, { start, end }))` (cast to
  `ReadableStream<Uint8Array>`). Privileges `{ standard, secure, stream, supportFetchAPI }`, registered
  before `ready`. Verified: seeking works for faststart, moov-at-end and HEVC MP4.
- CSP that works in dev (HMR) and production: `default-src 'self'; script-src 'self'; style-src 'self'
'unsafe-inline'; img-src 'self' data: blob: hc-media:; media-src 'self' blob: hc-media:; connect-src
'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'none'`.

## Paths

- Finder/Dock-launched apps get `PATH=/usr/bin:/bin:/usr/sbin:/sbin` → probe `/opt/homebrew/bin`,
  `/usr/local/bin`, `/opt/local/bin` explicitly.
- Set `app.setPath('userData', …)` at the very top of main (before anything touches the profile) when
  `HC_USER_DATA_DIR` is set. Keep `productName` in package.json so dev and packaged builds share the same
  userData/Keychain names.

## Playwright `_electron` (works with Electron 45, no browser download)

```ts
const env = { ...process.env, HC_USER_DATA_DIR: tmp, HC_FAKE_AI: '1', HC_E2E: '1' } as Record<
  string,
  string
>
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ args: ['.'], cwd: projectRoot, env }) // args ['.'] → productName is used
const page = await app.firstWindow()
await app.evaluate(({ dialog }, paths) => {
  dialog.showOpenDialog = (async () => ({
    canceled: false,
    filePaths: paths
  })) as typeof dialog.showOpenDialog
}, videoPaths)
await page.screenshot({ path }) // works with hidden windows
```

- With `HC_E2E=1` the app never `show()`s its window (no pop-ups on the user's desktop); it requires `HC_USER_DATA_DIR` and stores the API key without the Keychain.
- Any Electron launched without a userData override creates `~/Library/Application Support/Electron` –
  always override userData in harnesses.

## electron-builder

`mac.identity: '-'` (ad hoc, hardened runtime), `notarize: false`, arm64 `dir` target → `.app` in
`dist/mac-arm64/`. Don't use the template's list-style `extendInfo`.

Update (fix round, 2026-11-01): the build now sets `electronFuses` (see `electron-builder.yml` and
ARCHITECTURE §9). Setting fuses breaks Electron's linker signature; `identity: '-'` then signs the whole
bundle ad hoc with the hardened runtime through @electron/osx-sign (`codesign --verify --deep --strict`
passes; Gatekeeper still rejects it on other Macs). Ad-hoc helpers need `disable-library-validation`
to load the ad-hoc Electron Framework; `allow-dyld-environment-variables` would reopen
`DYLD_INSERT_LIBRARIES` (both verified 2026-11-06 on 45.2.3). With `EnableNodeCliInspectArguments`
off, Playwright's `_electron.launch` cannot attach to the packaged app – `build/verify-package.mjs`
starts it with `--remote-debugging-port` and `chromium.connectOverCDP` instead (the app strips that
switch at start unless `HC_E2E=1`). `node_modules`' Electron keeps its default fuses, so the snippet above
still works for E2E and UI snapshots.
