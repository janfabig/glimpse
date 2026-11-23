# Glimpse – Architecture & Spec

Personal macOS app (Apple Silicon) that turns ~5-minute first-person videos from Meta smart glasses
(festivals, nights out) into a highlight video. The user writes a prompt ("Your prompt", in code the brief);
Gemini watches every video and proposes timestamped moments; the user reviews/trims them; ffmpeg renders
the reel.

This document is the contract for everyone implementing a module. Shared types live in
`src/shared/types.ts`, the renderer API in `src/shared/ipc.ts`, internal service interfaces in
`src/main/contracts.ts`. **Do not change those three files without being asked** – if you need a contract
change, describe it in your report.

---

## 1. User flow (one project = one highlight video)

1. **Home screen** – list of projects ("New highlight video" + recent projects). First run without API key →
   onboarding card "Connect Gemini" with one line on privacy and the free quota (a stored key that can
   no longer be read → "Reconnect Gemini"). ffmpeg missing or not starting → blocking hint: the
   packaged app says "Glimpse is damaged" (it carries its own ffmpeg), a development build names
   `node scripts/fetch-ffmpeg.mjs`.
2. **Videos** – drag & drop from Finder or "Add videos" (native dialog, multi-select, files and
   folders). A dropped or picked folder adds the videos directly inside it (sorted by name like Finder;
   hidden files and subfolders are skipped). The dialog's message and the empty drop zone tell the user
   to export videos from the Photos app first (the dialog's Photos section waits for iCloud downloads
   and may hand over temporary copies). Each video is probed immediately (duration, size, recording time, poster). In
   the background a 720p H.264 **proxy** and a **filmstrip sprite** are created ("Creating
   previews: n of m done"). Videos are sorted chronologically. A failed preview shows its reason on the card and the footer
   warns with the count. A click on a card's poster ("Play original") plays the original in the
   Mac's default video app – e.g. to sort out accidental recordings before the analysis.
3. **Prompt** (`brief`) – the free-text prompt (a new project starts with one general prompt for concerts,
   festivals and evenings out; the field stops at the `LIMITS.promptMax` characters main keeps) and
   the target length (30 s / 1 min / 1:30 min / 3 min / No limit). Nothing
   else is a choice: every clip is 1 to 30 s long and Gemini always analyses the same way (§7). The
   footer says how many videos are analysed, how long that takes and what a 5-minute video costs with
   billing. Videos without a preview are left out of the count and the
   time estimate. When more videos wait than the model's free daily quota allows, the footer turns to a
   warning that names Flash-Lite or billing (the start stays possible). CTA "Analyse with Gemini".
4. **Analysis** – one row per video with its stage: waiting for the preview → uploading → Gemini is
   processing → looking for the best moments → done ("3 moments found") / error with the reason and the
   button that can help ("Try again", "Open Settings" plus "Try again" for once that is fixed,
   "Recreate preview" or "Go to Videos", §8). Cancel button. Two
   videos are analysed at a time (fixed). When the run finishes, moments are auto-selected for the
   target length – unless the user already edited the reel by hand and one of its clips is left: then it
   stays and the new moments are offered under "More suggestions". When Gemini found no moment in any
   video, the card says so and offers "Go to Prompt" (the Edit step needs a moment; another prompt is the way on).
5. **Edit** (`review`) – selected clips in output order (reorder, remove – the row's ✕ offers
   "Undo"), "More suggestions" (add): one list of the 10 best clips that are not in the
   highlight video, best first (score, then the shorter clip, then video order; `suggestions()` in
   `lib/moments.ts`). The clip shown in the editor stays listed even when it is not among those 10,
   and the tab's count is the number of rows. Player
   loops the active clip (proxy; with "Crop" the part the export cuts away is shaded), trim
   in/out (nudge buttons, set from playhead, drag handles on the filmstrip; a clip of the
   highlight video stops at its neighbours there, so no footage is in it twice),
   reset to AI times ("Gemini’s times"), "Play preview" plays the selected clips in
   sequence from the clip before the active one ("Preview from clip n" unless that is clip 1; it ends
   when a clip comes into the highlight video, leaves it or moves in it, and on any edit), total
   length vs. target, "Auto-select" (asks first when the reel was edited by hand). Back from
   another step (or project) it shows the clip and tab you left (clip 1 on "In the highlight video" once
   that clip is gone, e.g. its video was removed); the renderer keeps them per project while the app
   runs (`reviewFocus`), not in the project file.
   **"Ask Gemini again"** (header) opens a small dialog with one text field "What should Gemini do
   differently?". It says what happens and is the confirmation: the text (the user's note) becomes a new last line of
   the prompt (and stays there, editable in the Prompt step), Gemini looks at every video again (one
   request per video; the Prompt step's free-quota warning shows when the daily quota is too small for
   them on top of the project's analyses of the last 24 hours) and sees its earlier clips, everything it suggested before and the changes made to those clips are replaced, and the
   highlight video is put together again. The run is the usual Analysis step (§5 Jobs, "Second pass").
6. **Export** – four choices: format (9:16 Reels/TikTok, 4:5, 1:1, 16:9, Original), fit (Crop /
   Blurred background), transition (Hard cut / Crossfade) and the export folder →
   "Create highlight video" → progress → "Play" / "Show in Finder". Everything else is fixed
   (`EXPORT_FIXED` in `src/shared/presets.ts`, §6): 4K (2160 px short side) at 30 fps, H.264 in high
   quality, a fade in and out, loudness normalisation, crossfades of 0.4 s. The panel shows the
   frame, the estimated file size and how long rendering takes. Export history per project. A new
   project starts with the format, fit and transition of the most recently changed project (Settings'
   default folder applies).

Settings (gear icon): Gemini API key (stored with Electron `safeStorage` = macOS Keychain; never sent to
the renderer; a new key is tested first and stored only when Google accepts it), model, default
output folder, privacy note (EU terms of the free quota), System: ffmpeg status, data folder and
"Show log file in Finder". Not settings but fixed: 2 videos are analysed at the same time
(`ANALYSIS_PARALLEL` in `src/shared/presets.ts`), and an upload always stays on Google's side for
the next analysis (Google deletes it after about 48 h).

---

## 2. Stack & commands

- Electron 45 + electron-vite 6 (Vite 8) + React 19 + TypeScript 5.9 (strict), zustand, lucide-react,
  `@fontsource/montserrat`.
- Main process: Node APIs, `@google/genai` (Gemini), its own **ffmpeg/ffprobe** 9.0.2 (`vendor/ffmpeg`,
  shipped inside the app; always resolved to explicit paths, §6 Binary resolution).
- Tests: vitest (node) for main/shared; Playwright `_electron` for UI snapshots and E2E (no browser
  download needed).

| Command                  | What                                                                       |
| ------------------------ | -------------------------------------------------------------------------- |
| `npm run dev`            | app with HMR                                                               |
| `npm run typecheck`      | tsc for node + web projects (tests included, `noImplicitAny`)              |
| `npm test`               | vitest (unit + ffmpeg integration); the live Gemini test is skipped        |
| `npm run test:live`      | the live Gemini test – needs `GEMINI_API_KEY`, uploads a clip, uses quota  |
| `npm run ui:snap`        | UI screenshots with mock API → `artifacts/ui/*.png`                        |
| `npm run test:e2e`       | Playwright E2E against the built app with `HC_FAKE_AI=1`                   |
| `npm run package`        | `.app` in `dist/mac-arm64/`: fuses, ad-hoc signature, static check (§9)    |
| `npm run verify:package` | `build/verify-package.mjs`: fuses, asar integrity, signature, hidden start |
| `npm run package:zip`    | `npm run package`, then `dist/Glimpse-<version>.zip` for friends (§9)      |

`node scripts/fetch-ffmpeg.mjs` (once per checkout) downloads the pinned ffmpeg and ffprobe into
`vendor/ffmpeg`; the app, the tests, E2E and the scripts use them, and `npm run package` ships them.

Environment variables (main process):

| Var                                 | Effect                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `HC_USER_DATA_DIR`                  | overrides `app.getPath('userData')` (set before `ready`) – tests            |
| `HC_E2E=1`                          | hidden window, no Dock icon, key without Keychain; needs `HC_USER_DATA_DIR` |
| `HC_FAKE_AI=1`                      | use the deterministic fake analyzer (no network, no key needed)             |
| `HC_FAKE_AI_REQUIRE_KEY=1`          | with `HC_E2E=1` only: fake analyzer, but a key is required as in real use   |
| `HC_OUTPUT_DIR`                     | default export folder, in every build (meant for tests)                     |
| `HC_FFMPEG`, `HC_FFPROBE`           | explicit binaries (development and tests; the packaged app ignores them)    |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | API key fallback when none is stored (`apiKeySource: 'env'`)                |

Switches of tests and scripts (not read by the app):

| Var                                               | Effect                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| `HC_LIVE_GEMINI=1`                                | with `GEMINI_API_KEY`: the live Gemini test runs (`npm run test:live`) |
| `HC_MEDIA_PERF=1`                                 | opt-in media benchmark (`src/main/media/media.perf.test.ts`)           |
| `HC_E2E_MAIN`, `HC_E2E_TMP_DIR`, `HC_E2E_TRACE=0` | E2E: another build, parent of the temp dirs, no traces (`e2e/`)        |

---

## 3. Layout & ownership

```
src/shared/            contract (types.ts, ipc.ts, presets.ts, time.ts, media-url.ts, export-size.ts,
                       second-pass.ts, util.ts)                                      – frozen
src/main/contracts.ts  internal interfaces (MediaService, Analyzer, errors)          – frozen
src/main/media/        ffmpeg/ffprobe: probe, poster, proxy, sprite, render  → createMediaService()
src/main/ai/           Gemini analyzer + fake analyzer                       → createAnalyzer({fake})
src/main/core/         paths, stores, mutations, selection, jobs, protocol, IPC handlers, logging
src/main/index.ts      bootstrap (core owner)
src/preload/index.ts   typed contextBridge API (core owner)
src/renderer/          React UI + mock API (UI owner)
scripts/               test-video generator (media), UI snapshot harness (UI), fetch-ffmpeg.mjs
e2e/                   Playwright E2E (integration)
build/                 icons, entitlements, verify-package.mjs (checks a packaged app) (build),
                       make-zip.mjs and "How to open Glimpse.txt" (the zip for friends)
vendor/ffmpeg/         ffmpeg and ffprobe (git-ignored, fetched), LICENSE-FFMPEG.txt, SOURCE.txt
```

Tests sit next to the code as `*.test.ts` (vitest picks up `src/**/*.test.ts`); the two build scripts
with logic have `scripts/fetch-ffmpeg.test.mjs` and `build/make-zip.test.mjs`.

---

## 4. Data & storage

Types: see `src/shared/types.ts` (`Project`, `VideoInfo`, `VideoStatus`, `Moment`, `BriefSettings`,
`ExportSettings`, `AppSettings`, …).

```
<userData>/                       ~/Library/Application Support/Glimpse
  settings.json                   { model, defaultOutputDir }
  gemini-key.bin                  safeStorage-encrypted API key (never plaintext)
  logs/main.log                   append-only log (rotated at ~5 MB); Settings → System reveals it
  projects/<projectId>/
    project.json                  Project (atomic write: tmp file + rename, debounced ~300 ms)
    project.json.bak              the previous version, kept on every save (§5 Stores)
    project.json.damaged          a damaged project.json, set aside when the backup was restored
    media/<videoId>/poster.jpg
    media/<videoId>/proxy.mp4
    media/<videoId>/analysis.mp4  what Gemini gets: the proxy at 4 fps, mono (§5 Jobs)
    media/<videoId>/sprite.jpg
    tmp/export-<exportId>/        render scratch dir, deleted afterwards
```

Default export folder: `~/Movies/Glimpse/` (`app.getPath('videos')`), file name
`<Projektname> – Highlights <YYYY-MM-DD HH.mm>.mp4` (sanitised; no `/` or `:`; unique suffix ` (2)`).
Running exports reserve their names by `outputKey()` (NFC, lower case – APFS treats "Grünfest" in NFC or
NFD and "GRÜNFEST" as the same file). The final move never replaces a file: a name taken meanwhile gets
the next ` (n)` (§6), and the `ExportRecord` holds the path actually written.

Moments: `project.moments` holds every candidate, all found by Gemini. **Array order = output order**; the reel is
`moments.filter(m => m.selected)` in array order. Project files of older versions also hold clips the
user added by hand (`origin: 'manual'`, no `aiStart/aiEnd`; every moment had an `origin` then). The
field is not read: such a clip keeps its times, title, selection and place and is a clip like Gemini's
from then on (`store.test.ts` and E2E flow 5 open such a file). Older builds also stored what
nothing read – `tags` per moment, `rotation`, `fps` and `videoCodec` per video, `summary`, `usage`
and `momentCount` per analysis: they are dropped on load, the analysis stays valid. An automatic selection sorts the moments chronologically
(video order, then start). `project.reelEdited` is true once the user changed the reel by hand since the
last automatic selection (§5 Mutations); such a reel keeps its order and selection when videos are
analysed again (§5 Jobs). Project files without the flag load as `false`.

`briefHash = sha1(JSON.stringify({prompt: prompt.trim(), model})).slice(0, 12)` (core `briefHash.ts`,
mirrored by the renderer's `lib/brief-hash.ts`) – the
target length is _not_ part of it (selection handles that), and whitespace around the prompt does not
count (Gemini gets the prompt trimmed). An analysis is stale when its hash differs from the current one.
Older builds hashed more: the clip lengths and the analysis quality (options that are gone; the brief
in their project files still holds them), the oldest ones the prompt as typed. Loading a project drops
those options from the brief and rewrites an analysis whose hash is one of those of the stored brief
(`legacyBriefHashes`) to the current hash, so an update does not make every analysed video stale. The
same goes for an analysis made for the same prompt with other values of those options (the user
changed one and did not analyse again): `legacyOptionHashes` tries every value the old controls
allowed, once per old project file.

`ExportSettings` is `{ aspect, fit, transition, outputDir }`. Project files of older builds also hold
resolution, frame rate, codec, quality, the fade and loudness switches and the crossfade length:
loading reads the four choices, drops the rest (`mergeExportSettings`, lenient) and writes the file
back in the new shape; its export history stays (`store.test.ts`, E2E flow 3).

---

## 5. Main process (core)

### Bootstrap (`src/main/index.ts`)

1. `HC_USER_DATA_DIR` → `app.setPath('userData', …)`; `app.setName('Glimpse')`; on the real profile
   the data folder of the former name is moved over once (the name: see below).
2. Before `ready`: `protocol.registerSchemesAsPrivileged([{ scheme: 'hc-media', privileges: { standard:
true, secure: true, stream: true, supportFetchAPI: true } }])`.
3. On ready: log file, application menu, the `file:` guard (when the renderer is loaded from file, see
   below), `createMediaService()`, then `startCore` (`core/runtime.ts`: settings store, project store,
   job manager, broadcaster) with `createAnalyzer({ fake })` (fake = `HC_FAKE_AI === '1'`; an analyzer
   that cannot be created is replaced by one that reports "The analysis with Gemini is not available
   right now." + `LOG_HINT`), `protocol.handle('hc-media', …)`, IPC handlers, window. A failed start
   logs the error, shows a dialog ("Glimpse could not start") that names the log file (not with `HC_E2E`) and exits with
   code 1.
4. Window: 1360×860, min 1100×720, `titleBarStyle: 'hiddenInset'`,
   `trafficLightPosition: { x: 12, y: 19 }` (centres the 14 px traffic lights in the renderer's 52 px
   top bar; they end at x 72, inside its 84 px left padding, §8), `backgroundColor` from the macOS theme (`#141414` dark, `#eeeeee` light),
   `show: false` until `ready-to-show`;
   `webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false }`. Deny
   `window.open`; block `will-navigate` to anything but the app itself.
   Application menu (`core/menu.ts`): our labels (the standard macOS English names) on Electron's role items, so shortcuts, Services and
   the window list stay native – app menu (About, Services, Hide, Quit), "Edit"
   (undo/redo/cut/copy/paste/selectAll – this is what makes ⌘C/⌘V work in text fields), "View"
   (Toggle Full Screen), "Window". Reload, Force Reload and the DevTools only when `!app.isPackaged`.
   Closing the window (⌘W, the red button) keeps the app and its jobs running, as usual on the Mac;
   the Dock icon (`activate`) or a second launch opens a new window.
5. `before-quit` (the decision is `quitStep` in `core/quit.ts`, the flags and the dialog stay in
   `index.ts`): while an analysis or an export runs (`JobManager.hasUnfinishedWork()`; previews
   alone do not count, they are redone on the next start), ⌘Q, the menu and the Dock's "Quit" first
   ask as a sheet on the window (one is opened and brought to the front if needed): "Quit
   Glimpse?" – "An export or an analysis is running. If you quit, it is cancelled.",
   buttons "Keep working" (default, Esc) and "Quit"; Enter does nothing, so no key quits by
   accident (Electron's NSAlert gives one button only one key: `cancelId` = `defaultId` swaps Enter
   for Esc). Never asked: under `HC_E2E`, and
   on logout, restart and shutdown (`powerMonitor` `shutdown`) – the system is never held up. Then:
   cancel all jobs (kill ffmpeg), wait up to 5 s for them and for deletes of uploads on
   Google's side – core's own and the analyzer's background cleanup (`AnalyzeRequest.onCleanup`, e.g.
   an upload Gemini was still processing when the app quit) – then flush pending project writes
   (projects that still cannot be saved are logged). From the start of this shutdown the IPC calls
   that start work (`openProject`, `addVideos`, `retryPrepare`, `startAnalysis`, `analyzeAgain`,
   `startExport`) are refused with `busy` "Glimpse is quitting." (`core/runtime.ts`): the
   window is still open, and an ffmpeg started after the jobs were cancelled would run on without the
   app. Edits (`mutateProject`) are still taken and saved.
6. Sleep: while the TaskTracker holds any job (preview, import, analysis, export, deletes of uploads),
   core holds `powerSaveBlocker` `'prevent-app-suspension'` and releases it once the app is idle – the
   Mac does not idle-sleep, the display may. Closing the lid still sleeps it.

### The name (`core/appIdentity.ts`)

One name, `APP_NAME = 'Glimpse'`, everywhere:

- The labels of the application menu, the About panel (`app.setAboutPanelOptions`), the window title
  (`BrowserWindow` and `index.html`) and the UI texts. `productName: Glimpse` in `electron-builder.yml`
  names the app file (`Glimpse.app`, its binary and helper apps) and `CFBundleName`, which macOS shows
  in the menu bar and the Dock; the bundle id is `de.janfabig.glimpse`. The default export folder is
  `~/Movies/Glimpse`; a folder stored in `settings.json` or in a project stays as it is.
- `app.setName(APP_NAME)` in `core/early.ts`, and the same value as `productName` in `package.json`
  (Electron's name until main runs; electron-builder copies it into the app unchanged). Electron 45
  builds two names from it: the data folder (`userData` = `appData` + name) and the Keychain item of
  safeStorage (service = name + " Safe Storage", account = name + " Key"; set after the synchronous
  part of main has run, so `early.ts` decides it; the async API reads the same item).
- The former name, "Highlight Cutter" (`LEGACY_APP_NAME`): Electron creates the Glimpse folder with
  its caches before main runs, so `moveLegacyUserData` (called by `early.ts` on the real profile, never
  with `HC_USER_DATA_DIR`) moves the old folder's entries into it one by one when the Glimpse folder
  has none of the app's own (`settings.json`, `gemini-key.bin`, `projects/`, `logs/`), keeps Electron's
  fresh ones and deletes the rest of the old folder. `projects/` moves first, so a failed move leaves
  nothing moved and the next start retries; nothing moves while the old app runs (its `SingletonLock`
  names a live pid), and Chromium's `Singleton*` files never move. The absolute media paths stored in
  `project.json` and `project.json.bak` (proxy, poster, filmstrip) are rewritten to the new folder. `gemini-key.bin` is dropped: only the old Keychain
  item could decrypt it, so the user pastes the key once more; the old item stays until the user
  deletes it in Keychain Access. A failed move is logged to the console and the app starts anyway.
- Pinned by `core/paths.test.ts` ("the names Electron derives from the app name"),
  `core/appIdentity.test.ts` (`moveLegacyUserData`) and E2E `08-security` (`app.getName()` of the
  running app).

### IPC

- One `ipcMain.handle(IPC.<name>, …)` per invoke method of `HighlightApi` (channel names in `IPC`).
- Validate the sender (`event.senderFrame` belongs to our window) and every argument (types, ranges).
- Errors: throw `new Error(encodeIpcError({ code, message }))` with an English, user-facing `message`; the renderer
  uses `parseIpcError()`. Unknown errors → log, then `code: 'internal'` with "Something went
  wrong. You can find details in Settings under System → Log file." (`LOG_HINT` ends
  every text that points to the log). A full disk – errno `ENOSPC`/`EDQUOT` (also as an error's
  `cause`) or ffmpeg's "No space left on device" / "Disc quota exceeded" (macOS's strerror; "Disk …"
  elsewhere) in `MediaError.details` – becomes "There is not enough free space on your Mac.
  Free up some space and try again." (`DISK_FULL_MESSAGE`, `isDiskFull()` in
  `core/errors.ts`; media uses the same text). Only when the export folder is full and lies on another
  volume than the app's data (an external drive) is the folder named instead: "There is not enough free space in the export folder “{folder}”.
  Free up space there or choose another export folder when you export."
  (`folderFullMessage()`, media's `MESSAGES.outputFolderFull`; `userMessage()` keeps media's text).
- Events: `webContents.send(IPC_EVENTS.projectUpdated, project)` (throttled per project, ≤ 5/s,
  trailing edge guaranteed), `IPC_EVENTS.exportProgress`, `IPC_EVENTS.toast`. Where the order matters,
  jobs flush the project's pending update right away (`Broadcaster.flushProject` via
  `JobNotifier.flushProject`): before `startAnalysis` resolves (the renderer switches to the analysis
  step and must see the queue), before the toasts at the end of an analysis run, and before an export's
  terminal event (the project with its new `ExportRecord` comes first). Toasts are held until the
  renderer's first IPC call (any channel, at most 20), so notices from the start – a restored or an
  unreadable project – are not lost; the renderer subscribes to `onToast` before its first call. The
  same holds while no window is open (`Broadcaster.holdToasts()` when the last one closes): e.g. a
  failed export's toast reaches the window the Dock opens again. The renderer shows the toasts that
  arrive before `listProjects` has answered only then, so they get their project's name.
- `ToastEvent` fields beyond level and text: `sticky` – stays until closed (failed videos at the end of
  a run, a failed export, unsaved changes, a restored or an unreadable project); `projectId` – the
  project it is about (end of a run or an export, the relink toast of an import), so it leaves when another project or the start
  screen opens, and arriving while that project is not open it starts with the project's name;
  `key` (`TOAST_KEYS` in `shared/ipc.ts`) – a later toast with the same key replaces it:
  "Everything is saved again." closes the save warning, a run's failure toast the previous run's, and
  the renderer closes a project's failure toast when it starts that project's next run or export.
- The API key never leaves main (renderer only sees `hasApiKey` / `apiKeySource` /
  `apiKeyUnreadable` / `apiKeyRejected`).
- One one-way channel besides the invoke methods: `IPC_HANDED_OVER` (`registerHandedOverPaths`,
  sender check, absolute paths only) – the preload reports every path `getPathForFile` resolves.
- `openExternal` only for `https://aistudio.google.com/*`, `https://ai.google.dev/*`. `showInFinder`
  only for exports and originals of known projects, the output folders (and what is inside them) and
  the log file (`AppInfo.logFile` = `<userData>/logs/main.log`) – nothing else of the profile.
  `openFile` only for exports of known projects. `openOriginal(projectId, videoId)` takes
  ids, never a path: main looks the original up and opens it with `shell.openPath` (the default app; no
  Apple Events, which the hardened runtime forbids); a missing file gets the missing-original text.

### Preload (`src/preload/index.ts`)

`contextBridge.exposeInMainWorld('api', api)` where `api` implements `HighlightApi`: invoke methods →
`ipcRenderer.invoke(IPC[name], ...args)`; `getPathForFile` → `webUtils.getPathForFile(file)` (only a
real File from a drop or a file input has a path), and the path goes to main over `IPC_HANDED_OVER`
before the `addVideos` call that follows (same pipe, in order) – a folder the user dropped may be
listed; `on*` →
`ipcRenderer.on(channel, listener)` and return a function that calls `removeListener`. Sandboxed preload:
only `electron` may be required; shared constants are bundled by Vite.

### `hc-media:` protocol

- URL format from `src/shared/media-url.ts`: `hc-media://local/<encodeURIComponent(absPath)>`.
- Allow-list: files under `<userData>/projects/` **or** original video paths of known projects. Else 403.
- GET only. Must support HTTP **Range** (video seeking): `bytes=a-b`, `bytes=a-`, `bytes=-n` → 206 with
  `Content-Range`, `Accept-Ranges: bytes`, `Content-Length`; no Range → 200 with `Content-Length`;
  unsatisfiable → 416. Body: `Readable.toWeb(fs.createReadStream(p, { start, end }))`. Content-Type by
  extension (mp4/m4v → video/mp4, mov → video/quicktime, jpg → image/jpeg, png → image/png).

### `file:` protocol (`core/protocol/fileGuard.ts`)

Chromium lets a `file://` page fetch, show and play every other `file://` URL, which would bypass the
`hc-media:` allow-list. When the renderer is loaded from file (not with the dev server, which is http),
`protocol.handle('file', …)` serves only files inside the renderer bundle (`dirname(index.html)`, also
inside `app.asar`) through `net.fetch(…, { bypassCustomProtocolHandlers: true })` and answers every
other `file:` request with 403 (logged). Posters, sprites, proxies and originals reach the renderer only
through `hc-media:`.

### Stores

- `ProjectStore`: create/list/open/delete (`create` copies the export settings of the most recently
  changed project, without `outputDir`; the first project gets the defaults); `update(id, recipe)`
  applies a recipe to a clone, bumps `updatedAt`, schedules an atomic debounced write and a throttled
  broadcast. On open: migrate/normalise,
  reset transient states (prepare `running` → `pending`; analysis `queued|waiting-proxy|uploading|
processing|analyzing` → `cancelled` with message "Interrupted"), turn the status texts a German build
  stored (D14) into English (known ones translated, other German reasons dropped for the English
  fallback; `fromGermanBuild`), re-queue prepare for videos whose
  proxy/sprite is missing, register original paths with the protocol allow-list.
  - **Backup**: every write first turns the current `project.json` into `project.json.bak` (a hard link
    to a temp name, renamed over the old backup; a copy/clone on file systems without hard links), then
    writes the new file atomically – `project.json` is never missing. Best effort: saving goes on
    without a backup. The temp link is removed after the rename: when an earlier save failed past the
    backup step, `project.json` and the backup are one file and the rename does nothing (POSIX).
  - **Restore**: when `project.json` is missing, cannot be parsed or cannot be normalised, the backup is
    loaded, the damaged file is moved aside as `project.json.damaged`, the restored project is written
    back and a warning toast says "“{name}” was damaged and was restored from the last backup.
    The latest changes may be missing." When neither file can be opened – or
    `project.json` comes from a newer app version (never loaded, so never overwritten), or it could not
    be read at all (a disk error, no permission: the file may be fine and newer than the backup) – the folder
    and its media stay untouched (user data is never deleted automatically), the reason is logged and
    one error toast per start says how many projects could not be opened (with `LOG_HINT`). A folder
    without any project file is skipped silently. Both notices stay until closed (`sticky`).
  - **Failed saves** (e.g. a full disk) are retried every 5 s. The first failure of a streak shows one
    warning toast ("Your changes cannot be saved right now. Is the disk full? As soon as there is space
    again, the app goes on saving by itself.") that stays until "Everything is saved
    again." replaces it (same `key`) once every project is saved again – or the user closes it.
    The final flush on quit (`close()`) also writes what was changed while it was writing (at most
    three more rounds, so a quit is never held up). Projects still unsaved on quit are logged.
- `SettingsStore`: `settings.json` + key via the **async** safeStorage API (Electron 45:
  `isAsyncEncryptionAvailable`, `encryptStringAsync`, `decryptStringAsync` → `{ result,
shouldReEncrypt }`; see `docs/research/electron.md`), stored base64 in `gemini-key.bin` (mode 0600).
  If encryption is unavailable, refuse to store the key ("The macOS Keychain is not available. The API key was not saved.") – never write plaintext. Fallback
  to the env key. Default: `model = DEFAULT_MODEL` (from `src/main/ai`). Only `model` and
  `defaultOutputDir` are read from `settings.json` and written to it: the two options older versions
  stored there (the number of parallel analyses, whether uploads are kept) are ignored and gone with
  the next write. Inject an encryption interface so tests never touch the Keychain.
  The key is read lazily. Once a stored key fails to decrypt (e.g. the Keychain refuses access),
  `getAppSettings()` reports `apiKeyUnreadable: true` with `hasApiKey: false` and `apiKeySource: null`
  (with an env key: `true` / `'env'`); `startAnalysis`, `listModels` and `testApiKey()` without a
  candidate then answer "Your saved API key can no longer be read. Paste it again in
  Settings." Storing or deleting a key clears the flag.
  Google's verdicts about keys (`reportKeyCheck`: an analysis that fails with `auth` or succeeds, a key
  test with `rejected` or ok) are remembered for the session: while the key in use (the stored one,
  once read, or the env key) is among the rejected ones, `getAppSettings()` reports
  `apiKeyRejected: true` – Settings then says "API key rejected" instead of "Connected". Google
  accepting it again, storing another key or removing it clears it.
- `HC_E2E=1` (requires `HC_USER_DATA_DIR`, otherwise the app exits with code 1): never `show()` the
  window, hide the Dock icon, no background throttling, and store the API key with a profile-derived
  AES key (`core/settings/e2eCipher.ts`) instead of the Keychain, so E2E runs never prompt; closing
  the window quits (there is no Dock icon to reopen it) and quitting never asks (§5). With
  `HC_FAKE_AI_REQUIRE_KEY=1` in addition (ignored without `HC_E2E`), `fakeAi` is reported as `false`:
  onboarding, `startAnalysis` and `listModels` require a key as in real use, while the fake analyzer
  stays in use (its key test accepts any non-empty key) – the first start can be tested without Gemini.

### Mutations (`core/mutations.ts`, pure, unit-tested)

`applyMutation(project, mutation) → Project` (`updatedAt` is the store's job) – validates and
throws an IPC error (`invalid` / `not-found`) with an English text:

- `rename` (trim, 1–80 chars) · `setBrief` (merge the prompt and the target length, clamp the
  length to `LIMITS`, ignore unknown keys; a new `targetDurationSec` on a reel that was not edited by hand runs `applyAutoSelect` in
  the same mutation – an edited reel stays as it is) · `setExportSettings` (merge, validate the
  choices, ignore unknown keys) · `toggleMoment`
- `updateMomentTimes`: clamp to the clip's room (`trimBounds` in `core/selection.ts`),
  `end - start ≥ LIMITS.minMomentSec`, round to
  0.01 s; keeps `aiStart/aiEnd`; the times the moment already has (e.g. a trim key held at a limit)
  change nothing, not even `reelEdited` · `resetMomentTimes`: restore `aiStart/aiEnd` (a clip of an
  older version without them keeps its times)
- **No footage twice by hand** (the rule of the automatic selection, `sharesFootage`): `trimBounds` is
  `[0, video.durationSec]` on the 0.01 s grid, and for a clip of the highlight video it ends at the
  selected clips of the same video before and behind it – a trim stops there like at the ends of the
  video (a hand trim has no upper length limit). An edge that already lies inside a neighbour (projects
  of older versions) may stay, but moves no further in. `toggleMoment` does not take in a clip that
  shares footage with a selected one, and `resetMomentTimes` does not put a selected clip back on such
  times: both fail with `invalid` and `MUTATION_MESSAGES.footageTwice` – the clip that is in wins.
  Taking a clip out always works. The renderer computes the same room (`roomOf` in `ReviewStep`) and
  passes it to `withInPoint`, `withOutPoint` and `dragEdge` (`lib/moments.ts`), so keys, −/+, handles
  and "Here" stop where main would clamp; the mock mirrors all of it.
- `reorderMoment`: `toIndex` is the target position among the _selected_ moments after removing the moved
  one; implement by moving the item in the full array to just before the selected moment currently at
  `toIndex` (or after the last selected one when `toIndex ≥ count`).
- **Hand edits of the reel** (`REEL_MUTATIONS`: `toggleMoment`, `updateMomentTimes`,
  `resetMomentTimes`, `reorderMoment`) set
  `project.reelEdited = true`. `rename`, `setBrief` (incl. the target length) and `setExportSettings` leave
  it as it is; only an automatic selection resets it.

### Automatic selection (`core/selection.ts`, pure, unit-tested)

`autoSelect(project) → Moment[]` (new array, chronological order, `selected` flags updated). The
renderer's mock runs this file too, so it and `project/order.ts` import only `@shared` and each other
(`selection.test.ts` checks it).

- overlap `o = transition === 'crossfade' ? EXPORT_FIXED.crossfadeSec : 0`; effective length of a list =
  `Σ duration − o · (n − 1)`.
- No footage twice: a moment that shares footage with a clip already taken is skipped in every step
  below – `sharesFootage`: same video and `a.start < b.end && b.start < a.end`; clips that only touch
  are fine.
- **No target** (`targetDurationSec === null`): select the moments with `score ≥ 7`; if none, the 3 best.
  Both go by score desc, then duration asc, so the better of two overlapping moments wins.
- **Target T**: tolerance `max(2 s, 0.08·T)`.
  1. Diversity: each video's best moment with `score ≥ 6` (ties → shorter); add them best score first
     (ties → video order), each if it fits – a tight target goes to the best videos, not the first ones.
  2. Fill: remaining moments by score desc, then duration asc; add each that fits. When ≥ 3 videos have
     candidates, one video may fill at most 40 % of T (variety), unless nothing else is left.
  3. If effective length `< 0.85·T`: trim the best remaining moment symmetrically around its centre to
     the remaining budget (only if that is ≥ 1 s, `LIMITS.clipSec.min`) and add it (keep `aiStart/aiEnd`, store the
     pre-trim times in `autoTrimmedFrom`). The trim stays inside the moment, so it overlaps nothing
     either. Every run first restores `autoTrimmedFrom`, so a larger target gets the full clip back;
     editing or resetting the times drops the marker (the user's trim wins).
- Callers apply it with `applyAutoSelect(draft)`, which also resets `reelEdited` to `false`: the explicit
  `autoSelect` IPC ("Auto-select" – replaces selection and order even of an edited reel; the
  renderer asks first), the end of an analysis run whose reel was not edited by hand or would be left
  without a single clip, and a new target length (`setBrief`) on a reel that was not edited by hand.
  User trims survive an automatic selection.

### Jobs (`core/jobs/…`)

- **Import** (`addVideos`, `jobs/importer.ts`): a folder the user handed over – picked in the dialog
  (`pickVideoFiles` reports its results) or dropped (the preload reports `getPathForFile`'s paths,
  `IPC_HANDED_OVER`), kept per session in `JobManager.grantPaths()` – adds the video files directly
  inside it – one level, natural sort by name like Finder ("clip2" before "clip10"), hidden files and
  subfolders skipped, other files ignored silently, duplicates dropped; a folder without videos is
  skipped with "This folder has no supported videos.". Any other path – folder or file – that was
  not handed over is skipped as "Not a supported video file." and never opened: a script in the
  renderer cannot make main list a folder or read a file it merely names (§9). Every file is probed, fingerprinted and gets a
  poster; files that are no videos, unreadable or already part of the project (same path or same
  content) are skipped with a reason – also a file whose size or modification time changes
  while it is probed and fingerprinted ("The file is still being copied. …": a partial copy would
  be stored with the wrong size and later be refused by the export as changed). A file with the size and checksum of a video whose
  original no longer holds that content (moved, copied to another drive, or another file now at the
  old path) relinks that video instead: path, file name and fingerprint change, id, clips, analysis,
  preview and upload stay, a failed preview is queued again, and a toast says "“…” is linked
  again. Your clips are kept." ("N videos are linked again. …").
- **Prepare** (after `addVideos`, global concurrency 2): `makeProxy` (progress → `status.prepare`) then
  `makeSprite`; set `proxyPath/spritePath/spriteInfo`. Keep a `Map<videoId, Promise>` so analysis can
  await it. `retryPrepare` re-queues a failed one. Removing a video cancels its jobs, deletes its media
  dir and its upload on Google's side. Before the proxy, a free-space check (`jobs/diskSpace.ts`,
  `statfs`): the project's volume must hold proxy and sprite (`duration × 3 Mbit/s + 4 MiB`) plus a
  64 MiB reserve – otherwise the preview fails with the disk-full text before ffmpeg starts.
- **Analysis** (`startAnalysis`): requires an API key unless fake (`no-api-key`; the unreadable-key text
  when a stored key cannot be decrypted); one run per project (`busy`). Targets: `options.videoIds` or
  all videos without a fresh `done` result for the current `briefHash` (`force` → all). Resolves once
  the videos are queued and the queued state has reached the renderer (flush). A target without a proxy
  whose preparation failed (and is not queued again) is not queued: it fails right away, without
  calling Gemini, with remedy `'prepare'` and "The preview for this video is missing: {reason of the
  preparation}" – the same happens when a preparation fails while the analysis waits for it. Stages via
  `status.analysis` (queued → waiting-proxy → uploading → processing → analyzing →
  done/error/cancelled). 2 videos at a time (`ANALYSIS_PARALLEL`, fixed), one limit across all
  projects (Gemini limits are per key); a free slot goes to the run with the fewest running videos.
  `startAnalysis({ videoIds })` while a run with the same brief + model is active adds those videos to it
  (keeps "Try again" working); without `videoIds` or with a changed brief → `busy`. Errors that
  would hit every video (`auth`, `model`, non-retryable `quota`: daily quota, paid-only model, empty
  prepaid balance) fail the rest of the queue with the same message and remedy, without calling Gemini.
  Nothing to analyse (no run active, every video fresh, no `force`, no `videoIds`) resolves as a no-op:
  no error, no toast, the project unchanged (the renderer's async freshness check can lag behind).
  `cancelAnalysis` aborts running ones and marks queued ones `cancelled`.
  - **Analysis copy** (`PrepareQueue.ensureAnalysisCopy`): once the proxy exists, the analysis job
    makes `media/<videoId>/analysis.mp4` (`makeAnalysisCopy`, §6) and uploads it instead of the proxy:
    Gemini samples 1 fps (§7), so 4 fps and mono audio cut the upload to about 15–40 % of the
    proxy (measured on synthetic clips). It is made at the first analysis and again when the proxy is
    newer (mtime), else reused, so its fingerprint stays and kept uploads are reused. Meanwhile the
    stage is `uploading` (a few seconds). Before it, the proxy's free-space check (its estimate covers
    the smaller copy). It runs under the analysis job's signal (cancel, quit) and is deleted with the
    media folder. An upload kept from before the copy (fingerprint of the proxy) is replaced once.
  - **Remedy**: every `error` stage carries `status.analysis.remedy` (`analysisRemedy()`) – what can
    help: `auth`, `model` and non-retryable `quota` (daily quota, paid-only model, empty prepaid
    balance) → `'settings'`; per-minute `quota`, network, timeout, upload, processing, invalid
    response, unknown and unexpected errors → `'retry'`; `safety` → `'none'`; missing preview →
    `'prepare'`. `cancelled` has none, and neither have errors in older files (the renderer treats them
    as `'retry'`). Loading keeps a valid remedy, for `error` only.
  - **Uploads on Google's side** (`remoteFiles[videoId]`, `jobs/remoteFiles.ts`): every request passes
    `onRemoteFile` and `onCleanup`; the analyzer calls `onRemoteFile` once the reused or uploaded file
    is ACTIVE and core stores the
    ref right away (persisted), so a retry – also after an app restart – can reuse the upload, and
    removing the video or project deletes it. A response sets the key to `response.remoteFile`. The
    upload always stays for the next analysis, also after a failed or cancelled attempt (Google
    deletes it after about 48 h). A
    ref with another name replaces the old one, which is deleted; an upload reported after its video or
    project is gone, or late for an attempt that already ended, is deleted. Deleting a project reads
    `remoteFiles` from the live project after its jobs stopped and deletes them even if removing the
    folder fails. Every delete goes through `deleteRemoteFile()`: skipped while any project still refers
    to that name, in the background with a 30 s timeout, tracked under the TaskTracker key
    `'remote-files'` – quitting waits for it (within the shutdown timeout), a project's own settle does
    not. The analyzer's own background deletes arrive through `onCleanup` and are tracked the same way
    (`trackRemoteCleanup`): above all an upload Gemini was still processing when the analysis failed or
    was cancelled – core never heard of it (it is reported at ACTIVE), so quitting during "Gemini
    is processing the video…" now waits for its delete as well.
  - **Second pass** ("Ask Gemini again", `analyzeAgain(projectId, wish)` →
    `AnalysisRunner.start(id, { force: true }, wish)`): one IPC call, one step in main. The boundary
    takes a string that, trimmed, is not empty and at most `LIMITS.promptMax` (10 000) characters
    long (`wishArg`). Then the checks of every start (key, videos), `busy` while a run of the project is
    going, and `invalid` ("Your note no longer fits into your prompt. …") when prompt +
    line break + wish exceed `LIMITS.promptMax` (`appendWish` / `wishProblem` in
    `shared/second-pass.ts`, shared with the dialog and the mock). Only then, in one store update,
    `brief.prompt` gets the wish as its new last line (both trimmed; a wish that already is the end
    of the prompt – sent again after a failed run – is not added twice) and `reelEdited` becomes
    false – the user confirmed that the reel is put together again. Before that update the run reads every
    video's clips (`earlierClips`: all moments of the video with `aiStart/aiEnd`, else `start/end`,
    title, score, `selected`) and keeps them (`AnalysisRun.earlier`); each video's request carries
    its list as `AnalyzeRequest.earlierClips` – also when the video is queued again within the run
    ("Try again"). From there it is a forced run over all videos: same stages, cancel, errors,
    retries, kept uploads, "On success" and "End of the run" as below. A refused start changes
    nothing. A cancelled or failed second pass behaves like any cancelled or failed re-analysis: the
    wish stays in the brief, videos that were analysed have their new moments, the others keep their
    earlier clips and count as stale for the new brief; with at least one success the reel is
    selected automatically, with none it stays as it was and a reel edited by hand is protected
    again (`reelEdited` back to true). The second pass goes on with the next run: the lists of the
    videos it did not get through stay with the runner (`unfinished`, in memory, per project), and a
    later run of the same brief + model ("Try again", "Continue", "Analyse with Gemini")
    hands them to those videos. A changed brief or model, a new second pass or an app restart drops
    them – then, and for every video that got through, a run is a normal analysis without the list.
  - **On success**: replace this video's moments, new moments `selected: false`,
    `aiStart/aiEnd` set, inserted next to their chronological neighbours (`insertChronologically` in
    `project/order.ts`: right after the closest earlier moment – video order, then start; ties: the
    last one – else right before the closest later one; the order of the others stays, so in a
    reordered reel a new moment does not jump in front of a clip the user moved to the start); store `analyses[videoId]`, `remoteFiles[videoId]`; message "N moments
    found".
  - **End of the run** (≥ 1 success, also when it was cancelled – then without toast): decided at that
    moment, so edits made during the run count, and applied in the same store update as the run's last
    result (a success or a failure), so the renderer never sees a finished run without its reel. A run
    that ends otherwise (cancelled) settles in `finish()`. Then the project is flushed and the toasts
    follow:
    - `reelEdited` false, or an edited reel the run would leave without a single selected clip →
      `applyAutoSelect`, toast "Analysis done: N moments from M videos".
    - `reelEdited` true and a clip left → the reel stays: selection flags, order and times of every
      moment that was not replaced (the analysed videos' old AI clips left it – the renderer asked
      before). The new moments wait unselected under "More suggestions"; toast "Analysis done: N new
      suggestions. Your selection stays. You can find the new moments under “More suggestions”."
    - Failed videos (not after a cancel): one shared reason → "{n} video(s) could not be
      analysed: {reason}" (warning), or "The analysis failed: {reason}" (error) when nothing
      succeeded; different reasons → "{n} videos could not be analysed. The reason is shown at
      each video." "You can try again." is added only when every failed video has
      remedy `'retry'` (and a shared reason does not already say "again", `OFFERS_RETRY`). Sticky, with
      `projectId` and `TOAST_KEYS.analysisFailed(projectId)`.
    - The counts are per video, not per attempt (`run.results` / `run.failures`, keyed by video): a
      video queued again while the run goes on ("Try again") starts over, so one that works on
      the second try is not reported as failed and one that fails three times counts once; a removed
      video leaves the summary.
- **Export** (`startExport`): one per project (`busy`); needs ≥ 1 selected moment (`nothing-selected`) and
  ffmpeg (`no-ffmpeg`). **Memory** (`jobs/exportMemory.ts`, numbers in §6): ffmpeg gets half of the
  Mac's RAM (`os.totalmem()`, `JobContext.memoryBytes`). An export needs
  `2400 MiB × frame pixels / (2160 × 3840)` at its peak, with crossfades 300 MiB more – whatever the
  number of clips: hard cuts render clip by clip, and no ffmpeg run of a crossfade opens more than
  two clips (§6). An export next to running ones starts only when all of them fit (`busy`: "An export is
  already running in another project. This Mac does not have enough memory for a second one
  right now. …"): one at a time with 8 GB, three exports with 16 GB. Next to others every export
  counts as a 9:16 frame at least – ffmpeg's footprint has a fixed part, so three 1:1 exports would
  not fit into the 4 GB their pixels promise. An export alone runs unless its frame alone is over
  the budget: "Original" of a video wider or taller than about 3:1 with 8 GB (`invalid`: "This Mac
  does not have enough memory for this format: the picture would be too big. Choose another format
  when you export."). Original file missing → the missing-original text naming the file; an original whose size
  differs from the import ("The original file “…” is no longer
  the same as when you added it. …", size only, one `stat` per source). Creates the output folder
  (full disk → disk-full text, else "The export folder “…” cannot be created."), then checks free
  space before ffmpeg starts: the output volume must hold the estimated video (`estimateExportBytes`
  in `src/shared/export-size.ts`, also the size shown in the export step) and
  the project's volume the work files (`exportWorkBytes`: the same size for hard cuts; for
  crossfades × 1.5 for the near-lossless clips plus the longest clip's share of the estimate for its
  segment – each clip is deleted once its segment is written), summed when both are on one volume
  (`stat().dev`; deliberately generous for a crossfade, whose video is written only after the clips
  are deleted), plus a 64 MiB reserve – else it is refused with the disk-full text; when the short
  volume holds only the export folder (an external drive), with the folder text instead
  (`SpaceNeed.fullMessage`, `outputFullMessage()` for a folder that cannot be created). A work dir that
  cannot be created → disk-full text or "The export could not be prepared." + `LOG_HINT`.
  Builds `RenderJob` (clips from the **original** files, the frame of `EXPORT_FIXED`), output path
  (see §4), work dir, maps
  `RenderProgress` → `ExportProgress` (phases preparing/rendering/joining/finishing/done/error/cancelled,
  ≤ 8 events/s), appends an `ExportRecord` with the path media actually wrote, flushes the project,
  then sends the terminal event and the toast "Done! Your highlight video is saved.". A
  failure toast is sticky, with `projectId` and `TOAST_KEYS.exportFailed(projectId)`. Always deletes
  the work dir.

### Logging

`core/log.ts`: `log.info/warn/error(scope, msg, data?)` → console + `<userData>/logs/main.log`
(rotated at ~5 MB). Never log the API key: Google keys and every key that becomes known are redacted.
A failed write (e.g. a full disk) pauses the file for 30 s – console only meanwhile – then the logger
tries again and first notes how many lines it could not write.

---

## 6. Media (`src/main/media`)

`createMediaService(options?) → MediaService` (see `contracts.ts`). Throw `MediaError` with English, user-facing
messages; keep ffmpeg stderr tail in `details`. Failures the user can fix outside the app get their own
text and never trigger a fallback (another encoder or decoder, the poster's first-frame retry), because
every attempt would hit them (`errors.ts`: `environmentFailure`, `fsFailure`, `isEnvironmentFailure`):
a full disk (stderr "No space left on device" / "Disc quota exceeded" – macOS's strerror(EDQUOT) –
or "Disk quota exceeded", errno `ENOSPC`/`EDQUOT`) → the shared disk-full text (§5 IPC), except while
the final video is written into an export folder on another volume than the work dir (an external
drive, `namingFullOutputFolder` in `fsutil.ts`): then "There is not enough free space in the export folder “…”.
Free up space there or choose another export folder when you export."; a missing
permission ("Permission denied", "Operation not permitted",
"Read-only file system", `EACCES`/`EPERM`/`EROFS`) → "Glimpse is not allowed to write to the folder “…”.
…" for outputs, "Glimpse is not allowed to access the folder “…”. … “Privacy &
Security”." for inputs. Clip, join and save failures end with a next step ("Try again or remove
the clip from the highlight video.", "… or choose another transition when you export.", "Check
that the export folder can still be reached and try again.").

- **Binary resolution** (`toolchain.ts`, `appFfmpegDirs()`): the packaged app uses only its own copy,
  `Contents/Resources/ffmpeg/{ffmpeg,ffprobe}` (`bundledDir`) – no option, no environment variable, no
  Homebrew folder, no login shell, because other programs can write to those. Not packaged
  (development, tests, E2E): `options` → `HC_FFMPEG`/`HC_FFPROBE` → the repo's `vendor/ffmpeg`
  (`vendorDir`) → `/opt/homebrew/bin` → `/usr/local/bin` → `which` via a login shell PATH. vitest sets
  `HC_FFMPEG`/`HC_FFPROBE` to `vendor/ffmpeg` (`vitest.config.mts`) and the test helpers, E2E and the
  scripts take the same copy (`devBinary()` in `testVideos.ts`), so nothing needs Homebrew's ffmpeg.
  `status()` returns `{ ok: false, error }` when ffmpeg is missing or does not start: in the packaged
  app "Glimpse is damaged: the ffmpeg inside the app is missing or does not start. Replace the app
  with a fresh copy of Glimpse.", otherwise "ffmpeg was not found. In the project folder, run: node
  scripts/fetch-ffmpeg.mjs" ("ffmpeg was found but does not start. …"). An ffmpeg that was there at
  the start and cannot be spawned later: "ffmpeg could not be started. Quit Glimpse and open it
  again." Detect the hardware encoder (`h264_videotoolbox`),
  `-hwaccel videotoolbox` support and – with hardware decoding – GPU scaling (`gpuScaling`: smoke test
  `hwupload → scale_vt → hwdownload` for nv12 and p010le, with the rotation input options of the GPU
  proxy path) once (cache).
- **Runner**: spawn with `-hide_banner -nostdin -y -progress pipe:1 -nostats`; parse `out_time_us` /
  `out_time_ms` for progress against the expected output duration; `AbortSignal` → SIGTERM then SIGKILL
  after 2 s, reject with `MediaError('cancelled')`; on non-zero exit reject with stderr tail (a full disk
  or a missing permission in stderr replaces the caller's message, see above). Runs that read a whole
  video in the background have a time limit (`timeoutMs`: poster 60 s like the probe; proxy and sprite
  20 × the video's length + 2 min, per attempt), so an ffmpeg that hangs on a file that never answers
  is killed and ends as a normal failure (prepare error with its retry) instead of holding one of the
  two prepare slots – or an import – for good. The limit is counted in 1 s ticks: time the Mac spends
  asleep does not use it up. The analysis copy and the export have none (both can be cancelled).
- **probe**: `ffprobe -v error -print_format json -show_format -show_streams`. Display size honours
  rotation from `side_data_list` (Display Matrix `rotation`) or `tags.rotate`; fps from
  `avg_frame_rate` (fallback `r_frame_rate`). `recordedAt`: `com.apple.quicktime.creationdate` (carries
  its offset) first, then `creation_time` of the format, the video and the audio stream – read as UTC,
  except from cameras that store local wall-clock time (GoPro, DJI: handler name "GoPro …" / "DJI…",
  GoPro firmware tag `HD9.…` / `H22.…`, DJI encoder tag), whose zoneless or `Z` values are read as this
  Mac's local time for that date (DST included); explicit offsets always count. Clips already in a
  project keep their stored time. Fall back to the file's birthtime in core (not here). Internally the
  probe also reports the pixel format and the quarter turn of the display matrix (null for mirrored or
  odd angles) for the GPU proxy path.
- **fingerprint**: size + mtimeMs + sha1 of the first and last MiB. Relinking on import compares size
  and checksum only: a copy to exFAT/HFS+ or by `cp` changes the mtime.
- **makePoster**: frame at `atSec` (fast input seek), scaled so the longest side ≤ 640, JPEG q≈4.
- **makeProxy**: H.264 + AAC 128k stereo MP4, short side 720 (never upscale, even dims), constant frame
  rate: the `fps` filter is always applied (`fps=<rate>:start_time=0`, VFR → CFR); measured averages
  within 2 % snap to 24000/1001, 24, 25, 30000/1001 or 30, capped at 30. Keyframes forced at exact 1 s
  marks (the sprite decodes keyframes only), `-movflags +faststart`, `-pix_fmt yuv420p`, container
  metadata stripped (`-map_metadata -1`, no GPS in the upload). The proxy is upright and has no display
  matrix. Handles missing audio (no audio stream in proxy is fine). Attempts in order (`proxyAttempts`),
  each failure falls back to the next one (not for a full disk or a missing permission):
  1. **GPU scaling** – input options `-hwaccel videotoolbox -hwaccel_output_format videotoolbox_vld`
     and `-noautorotate -display_rotation:v:0 0`; filters `fps` → `scale_vt` on the stored (unrotated)
     picture → `hwdownload` → `format=nv12|p010le` → the SDR conversion (or `scale=out_range=tv`) →
     `format=yuv420p` → the rotation on the small frames (`transpose=clock`, `transpose=cclock` or
     `hflip,vflip`) → BT.709 tags. Only when `gpuScaling` passed and only for H.264/HEVC 4:2:0 sources
     (8 or 10 bit) whose display matrix is a pure quarter turn; mirrored or odd angles go straight to
     the classic path. `-display_rotation:v:0 0` keeps the matrix out of the output, so players do not
     turn the upright proxy again. Same frames, keyframes, colours and rotation as the classic path,
     39–65 % less CPU (measured 2026-11-01; the remaining HLG cost is libswscale's tone map).
  2. `h264_videotoolbox` (`-b:v 2500k`) with `-hwaccel videotoolbox` decoding, CPU scaling and ffmpeg's
     autorotation.
  3. `libx264 -preset veryfast -crf 26` (software decoding).
- **makeAnalysisCopy** (from the proxy, what Gemini gets): same picture size and timeline,
  `fps=4:start_time=0` (at least twice the rate Gemini samples, guarded by `ai/prompt.test.ts`),
  `libx264 -preset veryfast -crf 26 -maxrate 1000k -bufsize 2000k`, AAC 64k mono, faststart, metadata
  stripped; `-hwaccel videotoolbox` decoding when available. x264, not VideoToolbox: VideoToolbox holds
  its bitrate target, so 4 fps saved only ~40 % (measured). The BT.709 tags come with the proxy's frames.
- **makeSprite** (from the proxy): interval = `max(1, ceil(duration / 120))` s, tile width 160, single row
  `tile=<n>x1`, JPEG. Return `SpriteInfo`.
- **renderHighlight** (core of the export): the job names the frame (`RenderJob.frame`: short side
  and frame rate). The app always passes `EXPORT_FIXED` – 2160 px, 30 fps; the integration tests pass
  360 px, and one smoke test renders the 4K frame. The rest of the fixed set is the only path media
  has: H.264 at high quality, a fade in and out, loudness normalisation, crossfades of
  `EXPORT_FIXED.crossfadeSec` (0.4 s).
  1. Target size from `aspect` and the short side S: 9:16 → S×16S/9, 4:5 →
     S×5S/4, 1:1 → S×S, 16:9 → 16S/9×S, `source` → aspect of the first clip with short side S. Even dims
     (`outputSize` in `src/shared/export-size.ts`, also the frame shown in the export step).
  2. Per clip, one ffmpeg run: input seek `-ss seek -t input -i src` (frame-accurate when
     transcoding) with a **pre-roll**: decoding starts 0.5 s before the clip (less near the file start,
     more for clips at the end of the video stream, see Details), `input` = lead + clip + 0.1 s margin.
     An input seek can land on an open-GOP keyframe (HEVC CRA from VideoToolbox with B-frames, x265)
     whose leading pictures cannot be decoded from there – without the pre-roll the first frames of
     the clip would show a frozen copy of that keyframe. The lead is dropped again frame- and
     sample-exactly, right after `fps`, so the lead and the margin are never scaled or converted.
     Video: `fps=<fps>:start_time=0`, `tpad=stop_mode=clone:stop=-1`,
     `trim=start_frame=<lead>:end_frame=…`, `setpts=PTS-STARTPTS`, then `crop` →
     `scale=…:force_original_aspect_ratio=increase,crop=W:H`; `blur` → split, background
     scaled-to-fill at ⅛ size + `gblur` (sigma = 1/36 of the short side at full size, 60 px at 4K) +
     scaled up, foreground scaled-to-fit, overlay centred (the SDR
     conversion runs per branch); then `setsar=1,format=yuv420p` + BT.709 tags. Audio:
     `aresample=48000:async=1:first_pts=0`, `aformat=sample_fmts=fltp:channel_layouts=stereo`, padded
     and cut with `atrim=start_sample=<lead>:end_sample=…`; clips without audio get
     `anullsrc=r=48000:cl=stereo` of the same length. Side effects of the pre-roll: AAC at clip starts
     is primed, and on VFR sources a clip's first frame matches the proxy frame the user saw.
     The first clip fades in (0.5 s) and the last clip fades out (video `fade`, audio `afade`).
     Intermediate format: H.264 (`libx264 -preset veryfast -crf 16`, or VideoToolbox high bitrate) +
     **PCM s16le** audio in `.mov` – identical parameters for all clips so they can be joined losslessly
     and without AAC priming gaps.
  3. Join, for both transitions: concat demuxer (`-f concat -safe 0`), `-c:v copy`, audio → AAC 192k
     with `loudnorm=I=-14:TP=-1.5:LRA=11` over the whole reel, `-movflags +faststart`. `cut` joins the
     intermediates themselves: the intermediate video _is_ the final stream, so they are encoded
     with the final settings (`libx264 -preset medium -crf 17`, profile high; `h264_videotoolbox` at
     0.2 bit per pixel only when the ffmpeg build has no libx264). `crossfade` first turns the
     near-lossless intermediates into **segments** (`crossfadeSegments` / `crossfadeSegmentArgs` in
     `render/join.ts`), one ffmpeg run each, so no run opens more than two clips. Each
     intermediate's real duration is measured (ffprobe); a transition is 0.4 s in whole frames, at
     most half of either neighbour. Segment k is clip k without the frames
     the transition before it already showed, and its last T frames fade into the first T frames of
     clip k+1: inputs clip k and clip k+1 (`-t` T + 0.1 s), both decoded with `-threads 1`;
     `trim=start_frame=<skip>` / `atrim=start_sample=…` on clip k, `trim=end_frame=<T>` /
     `atrim=end_sample=…` on clip k+1, then `xfade=transition=fade:duration=T:offset=<segment − T>`
     and `acrossfade=ns=<samples>`. The last segment is the last clip without its first T frames.
     Segments are encoded with the final settings and PCM audio in `.mov`, like hard-cut
     intermediates. Every cut is frame- and sample-exact (reel = Σ d − Σ T), so they join without a
     doubled or missing frame or a click. An intermediate is deleted as soon as its segment is
     written.
     **Memory** (peak footprint of ffmpeg 9.0 on an 8 GB M-series Mac; RSS reads far lower there,
     because macOS compresses what does not fit). Rendering one clip at 2160×3840: 1.6 GB for a clip
     of 1 s, about 2.4 GB once x264's lookahead is full (from 0.40 / 0.70 / 1.13 GB for 6 s at
     720×1280 / 1080×1920 / 1440×2560); near-lossless intermediates for crossfades 1.5 GB. The join
     copies the video: 0.1 GB. A crossfade segment costs about what a clip render costs, whatever
     the number of clips: at 1080×1920 0.50 GB for clips of 1 s and 0.72 GB for clips of 2 s or 6 s,
     the same for 2, 8 and 24 clips; 1.22 GB at 1440×2560 (6 s); at 4K 1.7–1.8 GB for clips of 1 s,
     about 2.65 GB with a full lookahead (scaled from the smaller frames). With ffmpeg's default
     decoder threads an open clip costs twice as much (0.4 GB instead of 0.2 GB at 4K) and nothing
     gets faster, hence `-threads 1`. `exportMemory.ts` plans with 2400 MiB, plus 300 MiB for
     crossfades. Why not one run over all clips (the design until 2026-11): an `xfade` chain keeps
     every clip open and decodes all of them ahead – 0.2 GB per clip of 1 s at 4K and more for
     longer clips (6 clips of 5 s at 1080×1920 passed 2.5 GB), which limited a 4K crossfade to 8
     clips on 8 GB. The price is one encoder start per clip: the join of 24 clips of 2 s at 720×1280
     takes 9.5 s instead of 6.7 s (the whole export 18.1 s instead of 15.3 s), 2 clips of 1 s at 4K
     6.1 s instead of 4.6 s.
     Details: `fps=…:start_time=0` (late video streams), clips starting within 0.5 s or 2 source frames
     of the video end are decoded from there and hold the last frame, `-fflags +igndts` on the concat
     input, `asetpts=N/SR/TB` after loudnorm; loudnorm is skipped when no clip has audio and the join
     is retried without it if ffmpeg reports NaN/Inf (digital silence).
  4. Progress: rendering clips ≈ 85 %, joining ≈ 15 % (for crossfades the segments take 90 % of
     that share, the copy the rest); result `{ outputPath, durationSec, sizeBytes }`
     from a final ffprobe. Clean up nothing outside `workDir`; write output to a hidden temp name in the
     output folder, so a cancelled export leaves no half file. An export that dies with the app or
     the Mac cannot clean up: the next export removes such files from its export folder before it
     checks the space, and the project store removes them from `media/<videoId>/` when it loads a
     project (`removeStalePartFiles` in `core/fsx.ts`: the name pattern `.<name>.<8 hex>.part.<ext>`,
     regular files only, not written for a minute). The finished file is hard-linked to the
     final name, which never replaces a file (`writeNewFile` / `moveToFreeName` in `fsutil.ts`): when
     the name is taken by the file system's own rules (on APFS also in another case or Unicode
     normalisation), the next ` (n)` name is tried; file systems without hard links (exFAT, some
     shares) check, then rename. `outputPath` in the result is the file actually written. Proxies,
     posters and sprites still replace their file atomically (`writeAtomically`).
- **Meta-glasses specifics** (research 2026-11-01, see `docs/research/`): current Meta camera glasses record
  **portrait ~3:4** (≈1440×1920 at 30 fps, 3K up to ≈2384×3168, 60 fps ≈1344×1792, slow-mo 120 fps,
  hyperlapse without audio) stored upright without rotation flag. iPhone exports are **QuickTime .MOV,
  HEVC (hvc1) 8-bit, variable frame rate**, AAC stereo 48 kHz, sometimes **tagged HLG / BT.2020**, capture
  time in `com.apple.quicktime.creationdate` (prefer it over `creation_time`, which can be the later
  Meta-app processing time). Consequences: proxies and render intermediates must be **constant frame
  rate** (`fps` filter) and **SDR BT.709** – when `color_transfer` is `arib-std-b67` (HLG) or
  `smpte2084` (PQ), tone-map to SDR via libswscale colour management in the `scale` filter
  (`in_/out_transfer`, `in_/out_primaries`, FFmpeg ≥ 8), detected by a startup smoke test and applied
  after downscaling; fallback: matrix-only conversion plus a warning. (Homebrew ffmpeg 9.0.2 has no
  `tonemap_videotoolbox`, `libplacebo` or `zscale`; `scale_vt` maps HLG reference white to ≈55 % – too
  dark.) Posters of HDR sources are not tone-mapped. All proxies, intermediates and finals are tagged
  BT.709 (`setparams` + encoder options). Timeline: proxy timestamps start at 0 and map 1:1
  to input seeking in the original (`-ss` is relative to the file start). Select the first audio stream
  explicitly; clips without audio get silence.
- **Test videos** (`src/main/media/testVideos.ts`, node builtins only, no path aliases; also runnable via
  `npm run testvideos` → `scripts/make-test-videos.mjs`): `ensureTestVideos(dir)` creates (once, cached)
  short clips with distinct content: portrait 1440×1920 H.264 + stereo AAC with `creation_time`; portrait
  HEVC `.mov`; landscape 1920×1080 without audio; a clip with rotation metadata. ~20–40 s each.

---

## 7. AI (`src/main/ai`)

`createAnalyzer({ fake }) → Analyzer`; `DEFAULT_MODEL = 'gemini-3.8-flash'` exported from
`src/main/ai/index.ts`, plus a curated `MODEL_CATALOG` (3.8 Flash "Recommended", 4 Argon "Best quality:
only with billing turned on", 3.6 Flash, 3.5 Flash-Lite "Low cost"). Details of the current Gemini API
(model ids, SDK signatures, limits, pricing, errors) are in `docs/research/gemini.md` – follow that file,
not memory.

- **API**: `@google/genai` `models.generateContent` (not the Interactions API), always `store: false`,
  no `temperature/topP/topK`, `maxOutputTokens: 32768`, video part first (`fileData` +
  `mediaProcessing: STATIC` + `videoMetadata.fps`), then the text. One `GoogleGenAI` client per API key;
  HTTP timeout 10 min (Argon 20 min); no SDK retries – retries happen in our code.
- **Analysis settings** (fixed, `ai/request.ts`): 1 fps (`SAMPLING_FPS`) · `MEDIA_RESOLUTION_MEDIUM` ·
  thinking `MEDIUM`.
- **Upload**: the **analysis copy** of the proxy (720p, 4 fps, mono 64k, §6; never the original) via
  our own resumable uploader (fetch, 8 MiB chunks, progress + AbortSignal; protocol in the research
  notes), falling back to `files.upload` with `fs.openAsBlob` on protocol errors. Reuse
  `req.remoteFile` when its `proxyFingerprint` matches, it expires > 15 min from now and `files.get`
  reports ACTIVE. Poll state every 2 s until ACTIVE (timeout
  10 min; FAILED → `processing` error). As soon as the reused or uploaded file is ACTIVE – before stage
  `analyzing` – call `req.onRemoteFile(ref)` exactly once (never
  when processing fails or the key is rejected; a throwing callback is logged and ignored), so core can
  record the upload (§5 Jobs). The analyzer never deletes an ACTIVE upload: a successful analysis
  returns it as `remoteFile`, a failed or cancelled one leaves it for the next attempt, and core
  deletes it with its video or project (`deleteRemoteFile`: short timeout, never hang; 404 or a 403
  that names the file count as deleted). Deletes the analysis does not wait for – the upload of a
  failed or cancelled processing (never reported), an orphaned SDK upload that lands after a cancel –
  go to `req.onCleanup` (a throwing callback is logged; the delete runs anyway), so core tracks them
  and quitting waits; the analysis itself still ends right away.
- **Festival Wi-Fi** (`upload.ts`): a dropped connection or a stalled chunk never throws the upload
  session away. The uploader asks the server how much it has (`X-Goog-Upload-Command: query`), with
  pauses of 1, 2, 4, 8, then every 15 s for about 2 minutes (`RECOVERY_WINDOW_MS`), and continues from
  there; a lost answer to the finalize chunk is recovered from the query's `final` body. Every request
  has its own timeout: start 30 s, query 20 s, chunk adaptive (4× the last chunk's measured time,
  before that 64 KiB/s – 128 s for the first 8 MiB; doubled after each timeout; 30 s … 10 min). It
  gives up after the window, after 3 resumes without progress or 50 resumes in total, with a
  retryable `network` error (not retried again inside the analyzer). All retry attempts of one
  analysis share the session (a 5xx on a chunk resumes it), and an interrupted session is kept in
  memory per API key and proxy fingerprint, so trying again later in the same app session continues the
  upload – not after a cancel. A start request while offline still fails within about 10 s.
- **Request**: fixed system instruction + user prompt (template below) + file part, structured JSON
  output (schema below). Sanity checks: `finishReason`, block reasons, VIDEO prompt tokens ≥ ~40 % of
  `duration × fps × 70` (else the model did not see the video → retry once, then error).
- **Prompt**: role = expert editor of first-person (POV) smart-glasses footage; the user's brief verbatim
  (delimited, trimmed); constraints: each moment 1–30 s long (`LIMITS.clipSec`, fixed; Gemini picks
  the length each moment has by itself), no overlaps,
  chronological, start about one second before the action, set the end only once the action has
  resolved and the sentence, laugh, cheer or musical phrase is over – plus about one second (the
  schema's `end` description says the same) –, don't cut mid-sentence, avoid
  shaky/blurry/obstructed/ground-or-sky footage unless the brief wants it (the default prompt allows
  shaking while jumping and dancing), timestamps `MM:SS` within `00:00`–duration, score
  1–10 for fit to the brief, only the best moments, at most the schema's `maxItems` (quality over
  quantity; when little fits, a single moment with an honestly low score is enough – the schema
  requires ≥ 1; a video of up to a minute is asked for its single best moment), title (≤ 6
  words) + reason (1 sentence) **always in English**, whatever language is spoken in the video or
  used in the user's prompt (which may be in any language). Mention that audio matters (music drops,
  cheering, laughter, speech). The system instruction, the user prompt and the schema descriptions
  are English. The brief hash covers only the trimmed prompt and the model, so these texts make no
  analysis stale – a project of the German build keeps its German prompt (the old default started
  "Mach ein mitreißendes Highlight-Video aus meinen Aufnahmen. …") and its finished analyses.
- **Second pass** (`earlierClips` given and not empty, §5 Jobs): between the constraints and the
  brief the user prompt gets the block `SECOND PASS` – two sentences (this video was analysed
  before, the user was not happy, the change request is the end of the user's prompt; good
  clips may stay, others may change or be replaced) and the list between `<earlier>` and `</earlier>`,
  one line per clip in video order: `MM:SS–MM:SS | score n | in the highlight video | “Title”` (a
  suggestion: `not in the highlight video`). The list is data from an earlier answer, and says so:
  titles are one line, without quotes and angle brackets, at most 60 characters; at most 15 clips
  (those of the highlight video first, then by score). The list holds the clips of the pass before
  (after several second passes: of the last one). No list for a video without earlier clips, and
  none in a normal analysis. The system instruction stays the same.
- **Schema** (small – no numeric bounds, no `pattern`; only what the app uses – no summary, no
  tags): `{ videoEndsAt: "MM:SS", moments: [{ start: "MM:SS", peak: "MM:SS", end: "MM:SS", title,
reason, score: integer }] }` with `minItems: 1`, `maxItems: min(5, max(1, ceil(duration / 60)))` (`maxMomentItems`:
  one moment per minute, at most 5). Absolute score
  scale in the system instruction (10 unmissable · 7–9 strong · 4–6 ok filler · 1–3 weak).
- **Normalisation** (pure, unit-tested): parse timestamps with `parseStamp` (accept numbers too;
  overflowing fields are summed: `0:65` → 65 s, `04:62` → 302 s; an `M:SS` with SS ≥ 60 means SS
  total seconds only when the sum lies more than 5 s past the video end (closer, it is an overrun at
  the end: `01:62` → 122 s in a 120 s video), SS lies inside it and SS's minutes match M: `1:65` →
  65 s in a 100 s video), swap reversed start/end, drop clips starting at/after
  the end, clamp to `[0, duration]`, keep `peak` inside (default: centre), fit to
  1–30 s (`LIMITS.clipSec`; a shorter video lowers the minimum to its own length) around the peak
  within bounds, resolve overlaps (keep higher score, trim or
  drop the other), round score to an integer 1–10, trim strings (title ≤ 60 chars), sort by start. At
  1 fps Gemini's stamps are whole seconds, so every kept end gets a lead-out of 0.8 s
  (`END_PADDING_SEC`), bounded by the video's end, the next kept moment and `start + 30 s` –
  no clip is longer than 30 s; the fake's stamps are taken as exact. If the list is empty
  (the schema requires a moment), more than
  30 % of candidates were invalid, or `videoEndsAt` disagrees with the real duration by > 5 s while
  stamps overrun, retry the request once (an empty list with its own hint: name at least one moment).
  Two answers without a single usable moment are an `invalid-response` error, never a result – a
  result without moments would replace the video's clips.
- **Errors → `AnalyzerError`** (English messages, `messages.ts`; terms: "API key", "billing" – in
  Google AI Studio the user finds it under "Billing"): invalid key / permission →
  `auth` ("Google rejected your API key. Check it in Settings."); unknown model →
  `model`; 429 / resource exhausted → `quota` (retry with backoff, honour retry hints); a daily quota or
  a paid-only model → non-retryable `quota` with a self-contained text of 2–3 actions: try again
  tomorrow, switch model in the settings (the daily-quota text suggests Flash-Lite unless the user is on
  it already; the paid-only text 3.8 Flash, or Flash-Lite when 3.8 Flash itself is the paid-only one),
  or enable billing in AI Studio; an empty prepaid balance (402) → non-retryable `quota` ("… Top it up in
  Google AI Studio under Billing …"); 5xx / network → `network` (retry); blocked by
  safety → `safety`; unparseable JSON → one retry, then `invalid-response`; abort → `cancelled`. Max 4
  attempts, exponential backoff with jitter.
- **listModels / testKey**: list models that support `generateContent`, are Gemini text/multimodal models
  (exclude embedding, image, TTS, live/audio-only), recommended first. `testKey` → ok + "Connected:
  N models available" or the mapped error; a rejected key gets "Google rejected this API key.
  Copy it again in full in AI Studio." (it is not stored yet, so the way out is
  AI Studio, not the settings) and `rejected: true`, so core can mark a rejected key in use
  (`apiKeyRejected`).
- **Fake analyzer** (`HC_FAKE_AI=1`, `ai/fake.ts`): no network; simulates the stages with short delays
  (~0.3–0.6 s each, progress ticks), returns deterministic moments spread over the video (as many as
  the schema allows, 5 s each, without the lead-out), English titles. Like the real analyzer it reports its deterministic
  fake upload via `onRemoteFile` before analysing (the reused ref when reused). File names pick a
  failure (case-insensitive, the earliest stage wins): `auth` → key rejected at the start of the upload;
  `fail` → retryable `processing` error before the upload is ACTIVE; `quota` → the non-retryable
  daily-quota error while analysing; `safety` → a safety block while analysing. `testKey` ok for any
  non-empty key, `listModels` returns two fixed options. A second pass returns the same moments; each
  clip's reason ends with what the fake got: "Second pass: saw n earlier clips (m in the
  highlight video), note: “last line of the brief”" (E2E reads it from the new moments).
- **Live test** (`ai/live.test.ts`): the only test that calls Gemini – a 30 s synthetic clip at 1 fps.
  It runs only with `HC_LIVE_GEMINI=1` plus `GEMINI_API_KEY` (the key alone is the app's documented
  fallback, so developers often have it set): `GEMINI_API_KEY=… npm run test:live`.

---

## 8. Renderer (`src/renderer`)

English UI only (British spelling, "you"), short and action-oriented ("Add videos", "Analyse with Gemini").
Tone: professional but human and approachable. One clear primary action per screen; visible progress;
concrete time hints ("about 30–60 s per video"). Numbers and dates use `en-GB` (decimal point,
"14 Nov", 24-hour clock); `<html lang="en">`.

### Design system

- Colours ("cinematic neutral", `styles/tokens.css`): graphite greys like a pro video editor with one
  lime accent. Dark: background `#141414`, surfaces `#1c1c1c`/`#252525`, text `#f2f2f2`, accent `#c5f03c`
  with `#141414` text on it. Light: background `#eeeeee`, surfaces `#f8f8f8`/`#ffffff`, text `#171717`,
  accent `#3d6600` with white text. Borders are neutral white/black alphas; status colours (success
  teal, warning amber, danger coral) only for status. Every text pair meets WCAG AA. Fixed values only
  for black scrims and white on video, and the app icon/mark. Video areas (player,
  thumbnails, filmstrip, export preview) stay dark in both themes: `tokens.css` re-declares the dark
  tokens on them, `--media-bg` `#0b0b0b`.
- Font: **Montserrat** everywhere (`@fontsource/montserrat` 400/500/600/700, bundled – no network).
  Section headlines Montserrat Bold 16 pt (≈ 21 px); page titles may be larger.
- Dark and light theme follow macOS (`prefers-color-scheme`; main sets the window's `backgroundColor`
  from `nativeTheme`). Radius 10–14 px, generous spacing, visible focus rings,
  `-webkit-app-region: drag` on the top bar: 52 px high (`--topbar-h`) with 84 px left padding (`--traffic-lights`) – main centres the
  14 px traffic lights in it (`trafficLightPosition: { x: 12, y: 19 }`, §5 Bootstrap); they end at x 72.
- Icons: lucide-react.
- Terms: the reel is always "highlight video" (tab "In the highlight video", "Clip n in the highlight
  video", "Add to the highlight video"; never "reel" in the UI); the steps are Videos, Prompt,
  Analysis, Edit and Export (in code `videos`, `brief`, `analysis`, `review`, `export`); the user's
  text is "your prompt", the text of "Ask Gemini again" is "your note"; the source clips are
  "video n" / "original video"; "Gemini’s times" (not "AI times"); always "API key"; "billing"
  (in Google AI Studio: "Billing"); "preview", not "proxy"; "picture", not "frame". Quotes “…”,
  apostrophe ’, ellipsis directly after the word ("Uploading…"), sentence case.

### Structure

- `src/renderer/src/api/` – `api` = `window.api ?? createMockApi(scenario)`. The **mock API** implements
  all of `HighlightApi` in memory with realistic English sample data and simulated progress; scenario from
  the URL (`?mock=1&scenario=…`, `api/scenarios.ts`): `home`, `nokey`, `noffmpeg`, `ffmpegbroken`
  (the packaged app whose own ffmpeg does not start), `keyunreadable` and `keyrejected` (Settings open), `videos`,
  `previewfailed` (one
  filmstrip failed – its proxy is there –, one original gone, one conversion failed), `brief`, `analyzing`, `analysisfailed` (daily quota used up), `review`,
  `export`, `exporting`, `done`, `settings`. No `hc-media:` URLs in mock mode → placeholders. The mock
  mirrors main's behaviour: remedies and the fake analyzer's file-name triggers (fatal errors fail the
  rest of the queue), failed previews (no proxy) failing their analysis right away, main's failure
  toasts (sticky, with `projectId` and `key`) and its per-video run summary, the re-selection for a new
  target length (in `applyMockMutation`, like core's `applyMutation`) and for an edited reel left
  empty, `apiKeyUnreadable`, `apiKeyRejected`, the key-rejected text, `logFile`, a broken ffmpeg,
  folder import and `analyzeAgain` (the same checks in the same order, the wish in the brief, the
  reel automatic again – and protected again when the run ends without a result –, a forced run); its model list is the real `MODEL_CATALOG`. Its texts (`mock-messages.ts`)
  are copies of core's, ai's and media's; `mock.test.ts` checks them against main. For the
  auto-selection it runs core's `autoSelect` itself (`core/selection.ts`).
- State: zustand store fed by `onProjectUpdated` / `onExportProgress` / `onToast`.
- Screens: Home, Project (stepper Videos → Prompt → Analysis → Edit → Export), Settings modal, toasts.
- Media: `mediaUrl()` from `@shared/media-url` for posters, proxies and sprites; filmstrip tiles via
  `background-position` from `SpriteInfo`.
- Review keyboard shortcuts: Space play/pause, ↑/↓ previous/next clip of the open tab in the order
  shown (a clip X just moved to the other list keeps its place until you move on or change the tab,
  so X ↓ X takes out two neighbours; with a clip shown that is not listed on the open tab they
  start at its top row), I/O
  set in/out at the playhead, X toggle clip, ←/→ nudge playhead 1 s, `,`/`.` start −/+0.5 s and
  `-`/`+` end −/+0.5 s (`=` too, for US keyboards). Arrows and
  trim keys repeat while held, the toggles Space, X, I, O do not. The −/+ buttons step once on press,
  then every 110 ms after 400 ms while held (Enter on a focused button: one step; Space stays
  play/pause).
- Every trim with −/+, the trim keys, a handle drag or a handle's ←/→ (also a plain handle click)
  seeks to where the edit is heard (`editPoint`): the new start, or 2 s before the new end (at most
  back to the start); playing or paused stays. The loop gets the new range before that seek, so it
  keeps looping the clip; I/O do not seek and leave a loop that was left with a seek as it is.
- Trim handles (`Timeline`): the edge keeps its distance to the
  pointer from the press, so it moves exactly as far as the pointer, wherever the handle was grabbed.
  A press that moves less than 3 px is a click and changes nothing; only a changed range is saved
  (`updateMomentTimes` marks the reel as edited by hand), a drag back to where it began saves nothing.
  A press also focuses the handle, so ←/→ move its edge by 0.1 s (⇧ 1 s) right after a click.
- Every root screen sets `data-screen="<name>"`, and the app sets `data-ready="true"` on `<body>` once the
  first data is loaded (used by snapshots/E2E). Stable `data-testid`s (E2E relies on them):
  - global: `open-settings`, `toast` · settings modal: `api-key-input`, `save-api-key`, `test-api-key`,
    `api-key-result`, `api-key-unreadable`, `api-key-rejected`, `connection-state`, `remove-api-key`,
    `model-select`,
    `privacy-note`, `show-log-file`, `close-settings`
  - home: `new-project`, `project-card`, `onboarding` (`onboarding-text`, `onboarding-key-input`,
    `onboarding-connect`, `onboarding-error`, `onboarding-privacy`), `ffmpeg-missing` · stepper:
    `step-videos`, `step-brief`, `step-analysis`, `step-review`, `step-export`, `next-step`
  - videos: `add-videos`, `video-card` (attr `data-prepare="<status>"`), `remove-video`, `prepare-error`,
    `retry-prepare`, `remove-missing-video`, `preview-failures`
  - brief: `brief-prompt`, `target-<seconds>` / `target-none`, `target-hint`, `start-analysis`
  - analysis: `analysis-row` (attr `data-stage="<stage>"`), `cancel-analysis`, `retry-analysis` (remedy
    `'retry'`, cancelled rows, and next to `analysis-open-settings` for remedy `'settings'`),
    `analysis-open-settings`, `rebuild-preview`, `analysis-go-videos`,
    `analysis-summary`, `analysis-failure-reason`, `retry-failed`, `failed-open-settings`,
    `failed-go-videos`, `go-review`
  - review: `clip-item` (selected, attr `data-moment-id`), `suggestion-item`, `clip-toggle`,
    `nudge-in-minus`, `nudge-in-plus`, `nudge-out-minus`, `nudge-out-plus`, `reset-times`, `auto-select`,
    `preview-all`, `total-duration`, `go-export`
  - review, "Ask Gemini again" (`AgainDialog.tsx`): `again-open` (off with the reason as tooltip
    while an analysis runs, without videos or without a key – `againBlocker` in `lib/again.ts`),
    `again-dialog`, `again-wish`, `again-start` (off without text or when the note does not fit:
    `again-too-long`), `again-quota` (the Prompt step's free-quota warning for all videos plus the
    analyses of the last 24 hours). `again.css` hides the Edit step's subtitle up to 1420 px: the
    third header button needs its room at the default window size
  - export: `aspect-<value>` (e.g. `aspect-9:16`), `fit-<value>`, `transition-<value>`, `start-export`,
    `export-progress`, `export-done`, `open-output`, `show-in-finder`

### Feedback, failures and safeguards

- **Toasts** (`lib/toast.ts`): each stays for a reading time – 1.5 s plus 60 ms per character, within
  4.5–10 s (info, success), 7–20 s (warning) or 9–25 s (error), 3 s more with an action button. What
  main marks `sticky` stays until closed: the failures at the end of an analysis run or an export, the
  warning that changes cannot be saved (until "Everything is saved again." replaces it – same `key`), a
  restored or an unreadable project. At most 4 toasts; the oldest non-sticky one goes first
  (`addToast`). Toasts about a project (`projectId`: main's run, export and relink toasts, the renderer's
  "… added" / "… skipped" after an import) and toast buttons leave when another project or
  the start screen opens (`toastsForScreen`); starting a project's next run or export closes the
  failure toast of the previous one (`TOAST_KEYS`). One that arrives while its project is not open
  (another project or the start screen) starts with the project's name, e.g. “Lisa’s birthday”:
  Analysis done: 5 moments from 2 videos (`showToast`; without a prefix when the project list does
  not know the project); opening that project drops the name again (`leaveScreenToasts`). They sit
  bottom-centre above the footer; in the Edit step top-right over the player (`review.css`), so the
  timeline and the trim handles stay free.
- **Taking clips out** (`store/actions.ts`): the ✕ of a row in “In the
  highlight video” (`removeFromReel`) shows ““…” was removed from the highlight video.” with “Undo”,
  which takes the clip back in – main's `toggleMoment` keeps its place in the order. One such toast at
  a time (key `reel-undo`), and it leaves when "Auto-select" or an analysis start replaces
  what it was about; X in the Edit step toggles without one. There is no ⌘Z history.
- **Items main is changing** (`AppState.pending`, `changeItem()` in `store/actions.ts`): removing a
  video and taking a clip into or out of the highlight video run at most once per
  item; the item renders disabled until main answers. One shared filter (`lib/click-guard.ts`) ignores
  the second click of a double click and a second click on the same spot within 500 ms on these item
  buttons and on the chevrons that move a clip – the list reflows under the pointer, so it would
  otherwise hit the next item (and move it back). A press
  anywhere else in between (`pointerdown`, watched on the window) ends that window: the next click on
  the spot is meant, e.g. the X of a video that took the place of one removed via the dialog. The
  poster button “Play original” uses the same filter, so a double click opens the original once.
- **Dialogs** (`Modal`, `lib/focus-trap.ts`): Tab and Shift+Tab stay inside the topmost dialog. Focus
  starts on the control marked `data-autofocus`: the API-key field when a key has to be pasted (none,
  unreadable or rejected), the confirm button of a confirm dialog, "Cancel" when the action is
  destructive. Settings often opens before main's fresh answer (a key found unreadable or rejected
  just now): when that state arrives while the dialog itself still has the focus, the key field gets
  it.
- **Failed analyses** (`lib/analysis.ts`): a row shows the reason in up to 3 lines (full text as
  tooltip) and the button of its remedy (`failureAction`): `'retry'` and cancelled rows → "Try
  again"; `'settings'` → "Open Settings" and next to it "Try again" for once that is
  fixed (another model, a new key, billing – or the next day; without it the only way back would be a
  new run from the Prompt step, which the model change makes re-analyse every video); `'prepare'` → "Recreate
  preview" (`retryPrepare`, then the video joins the analysis and waits for its preview), or "Go to
  Videos" when the original is gone; `'none'` → no button. A `'prepare'` failure whose preview
  exists meanwhile (the original is back, the preview was made in the Videos step) counts as `'retry'`
  and reads "The preview is ready now. Try the analysis for this video again."
  (`currentRemedy`, `failureText`). Errors without a remedy (older projects) count as `'retry'`. The
  summary card names the shared reason; with `'settings'` failures it offers "Open Settings"
  plus a retry of everything trying again can help with (`'retry'` and `'settings'` videos), otherwise
  its button retries the videos with remedy `'retry'` ("Retry failed videos" / "Retry N
  videos"), else "Go to Videos".
- **Failed previews**: the card shows the reason in up to 4 lines; a missing original gets a short
  text ("Original file not found. Was it moved? Add it again.": re-adding relinks it, §5
  Jobs) plus "Check again" and "Remove". The Videos footer warns with the count (a failed filmstrip
  alone is named apart: "1 video has no filmstrip"). The Prompt step leaves the
  videos without a proxy out of the count and the time estimate (`previewFailed`, `analysisPlan`: "· 1
  video without a preview is skipped") and disables the start with a "Go to Videos" hint when only
  such videos are left – a video whose filmstrip alone failed has its proxy, and main analyses it. A
  missing original is recognised by its text (`isMissingOriginal`: core's
  `JOB_MESSAGES.missingOriginal`, media's "The file “…” was not found."; main turns the old German
  texts of both into the first when it loads a project).
- **API key**: the settings are read again whenever Settings opens, after a `no-api-key` error and
  after a key test with a verdict (an older read never overwrites a newer change). Settings and the onboarding card test a new key first
  and store it only when Google accepts it (`connectApiKey`), so a rejected key never shows
  "Connected". An unreadable stored key shows "API key unreadable" with a hint under the field ("Remove
  API key" stays available), "Reconnect Gemini" on the home screen and the unreadable-key text
  in the Prompt step's footer and toast. A key Google rejected later (deleted or revoked in AI Studio; main's
  `apiKeyRejected`) shows "API key rejected" with the hint to paste a new one (`api-key-rejected`).
- **ffmpeg**: the home screen's blocker follows main's `FfmpegStatus` (`ffmpegBlocker()` in
  `lib/system.ts`). Main's error names the command `node scripts/fetch-ffmpeg.mjs` only in a
  development build: then the blocker is "ffmpeg is missing" (both binaries found but not starting:
  "ffmpeg does not start") with main's sentence, the command as a code block with "Copy command" and
  a hint that Homebrew's ffmpeg works too. Without a command it is the packaged app: "Glimpse is
  damaged", unzip Glimpse again and replace the app, "Your projects and settings are kept." – no
  command, no Homebrew. "Check again" shows main's fresh error. Settings → System shows main's
  message (`ffmpegHint`), in development with the command and "Then click “Check again” on the home
  screen." – main looks for ffmpeg anew while none works, no restart needed.
- **Privacy and cost**: the onboarding card says that a 720p copy of every video goes to Google and is
  deleted there after at most 48 h, and that the free quota allows only about 20 analyses per day. The
  Prompt step's footer shows "with billing about X–Y cents per 5-minute video" for the selected model
  (`costHint` in `lib/cost.ts`, from the
  research price table, including the end of promotional prices; `cost.test.ts` requires a price for
  every catalog model). The app cannot see
  whether billing is on: when more videos wait than the model's known free daily quota
  (`freeQuotaWarning` in `lib/cost.ts`), the Prompt step's footer switches to the warning tone and appends
  "Without billing, the free quota (about 20 analyses a day) is not enough for all of them. …"
  (Flash-Lite or billing; nothing for a quota of unknown size or a paid-only model). Settings shows the EU privacy note and, under System, "Show log file in Finder"
  (hidden when `AppInfo.logFile` is missing).
- **Target length**: a value from elsewhere (e.g. the 45 s of an older project) is labelled like the
  others ("45 s") and sorted in before "No limit"; the control wraps at 1100 px.

### Protecting a reel edited by hand

Main decides (§5 Jobs); the renderer only asks before something made by hand is lost and says what
happens:

- **Before a run** (`startAnalysis` action, `lib/analysis.ts`): the targets are computed like main
  (`analysisTargets`), then `reanalysisImpact` decides. The new moments replace the target videos'
  moments. `reelEdited` false → the reel is rebuilt automatically afterwards, so
  only the user's own trims of replaced clips count (`hasOwnTrim`; a trim by the automatic selection does
  not count – own trims survive "Auto-select", so they can exist without the flag; a clip
  without `aiStart/aiEnd`, added by hand in an older version, counts like an own trim).
  `reelEdited` true → the target videos' clips in the reel and their own trims count. Nothing at stake
  → no dialog. Otherwise the confirm dialog (`confirm-dialog` / `confirm-ok`) says concretely how many
  clips leave the reel, which trims are lost and what stays: the other clips in their order – or, when
  none of them would be left, that the highlight video is put together automatically again (main does
  that; `reanalysisImpact` then reports `rebuilt`).
- **"Auto-select"** (`auto-select`): with `reelEdited` and at least one clip in the reel it asks
  first ("Auto-select again?" – selection and order are replaced, trims stay);
  otherwise it runs right away.
- **Target length**: an untouched reel (`reelEdited` false) is selected again for a new length right
  away (main, `setBrief`); an edited reel stays. The hint under "Target length" (`target-hint`) says which
  of the two happens – with an edited reel, that “Auto-select” in the Edit step applies the new
  length.
- Texts that describe the end of a run follow `reelKeptAfterRun()`: the analysis footer and summary,
  and the review footer while a run is going ("Your selection stays, new moments go to “More
  suggestions”"), promise a kept reel only when one of its clips survives the run (a
  clip of a video the run does not analyse).
- **"Ask Gemini again"** asks nothing more: its dialog says that everything Gemini suggested and
  the changes to those clips are replaced and the highlight video is put together anew, and main
  resets `reelEdited` when the run starts – and sets it again when the run ends without a single
  result (§5 Jobs, "Second pass"). While the dialog is open the
  Edit step's shortcuts rest; Esc closes it, Enter in the field is a new line.
- The mock API mirrors main: the flag in its mutations, autoSelect and analysis end, the insertion of new
  moments and the no-op start. In the mock world the Parookaville reel is edited by hand (one clip
  trimmed), so the `reanalyze` snapshot shows the dialog.

### UI snapshots

`scripts/ui-harness/` (minimal Electron main without preload that loads a renderer build with
`?mock=1&scenario=…`) + `scripts/ui-snap.mjs` (Playwright `_electron`) → `artifacts/ui/<shot>.png` at
1440×900 and `artifacts/ui/<shot>@1100x720.png` at the minimum window size. A shot is a scenario,
optionally with a step (e.g. `keyunreadable-home`, `previewfailed-brief`, `settings-system`); look at
every changed screen at both sizes. Build the renderer for snapshots with its own Vite config (renderer
only), so a broken main process build does not block UI work. `scripts/ui-harness/flow-check.mjs`
clicks through the whole flow against the mock (offscreen) and fails on any console error; it also
guards double clicks on remove buttons, the focus inside dialogs, the re-analysis confirmation and
"Ask Gemini again" (its dialog, the keys behind it, the run, the note in the prompt, the
header's subtitle not cut at 1360 px; shot `again`).

---

## 9. Security

contextIsolation + sandbox, no nodeIntegration, CSP in `index.html`, IPC sender + argument validation,
`hc-media:` allow-list, `file:` limited to the renderer bundle (403 otherwise, §5), `openExternal` and
`showInFinder` allow-lists, API key only in main (Keychain-backed), no remote content in the window,
English application menu without Reload and DevTools in the packaged app. `addVideos` reads only
files and folders the user handed over (picked in the native dialog or dropped – the preload reports
the paths of real dropped Files, §5 Jobs) and the videos directly inside such a folder: any other path
is skipped as "Not a supported video file." without being opened, so a script in the renderer can
neither list a folder such as `~/Movies` nor import (and then stream over `hc-media:`) a file whose
path it guesses. Relinking is unchanged: the new path is handed over, the old one is already in the
project.

**Untrusted files**: every ffprobe run and every ffmpeg input of a file the user picked (probe,
poster, preview and analysis copy, filmstrip, clip render) gets `LOCAL_VIDEO_INPUT`
(`media/ffargs.ts`): `-protocol_whitelist file -format_whitelist mov,matroska,avi,mpegts`, the
demuxers of `VIDEO_EXTENSIONS`. A concat list or HLS playlist named `.mp4` is refused instead of
making ffmpeg read the files (or URLs) it names (`media/inputs.integration.test.ts`). The joins open
only the app's own intermediates through its own concat list and keep their options. Loading a
project drops a stored Gemini upload whose name is not `files/<id>` (lowercase letters, digits and
hyphens, at most 40) or whose uri is not on `https://generativelanguage.googleapis.com` – the video is
simply uploaded again – and `ai/files.ts` checks the same name (`isGeminiFileName` in `contracts.ts`)
before it goes into an SDK request path (get, delete, the name an upload returns). Ids
(`core/ids.ts`) never are `prototype` or a name `Object.prototype` has (`__proto__`, `constructor`,
`toString`, …): they key plain objects (`status`, `analyses`, `remoteFiles`), where `__proto__` would
replace the object's prototype and the others read Object's own function as an entry; an old
project with such an id drops that video like any other invalid entry. A project file nested
arbitrarily deep under a key the app ignores still loads: `JSON.stringify` (the repair compare) is
iterative in Electron 45's V8, and the normalised project keeps none of that nesting.

**Electron fuses** (`electronFuses` in `electron-builder.yml`, set in the packaged copy only):
`runAsNode`, `enableNodeOptionsEnvironmentVariable` and `enableNodeCliInspectArguments` off (no
`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect` or SIGUSR1 inspector – SIGUSR1 just ends the app),
`enableEmbeddedAsarIntegrityValidation` and `onlyLoadAppFromAsar` on (an app.asar that does not match
its hash in `Info.plist` is refused). `grantFileProtocolExtraPrivileges` stays on (the renderer is
loaded from `file://`), `enableCookieEncryption` stays off (Chromium would use the Keychain too, also in
E2E runs). `mac.identity: '-'` signs the whole bundle ad hoc with the hardened runtime after the fuses
are set: `Info.plist` with the asar hash is bound into the signature, the app has a code identity of its
own instead of sharing it with every stock Electron binary of the same version, and dyld ignores
`DYLD_INSERT_LIBRARIES` & co. in the app and its helpers. `build/entitlements.mac.plist` (app and
helpers) holds `allow-jit`, `allow-unsigned-executable-memory` and `disable-library-validation` (ad-hoc
helpers cannot load the ad-hoc Electron Framework without it) – never `allow-dyld-environment-variables`,
which reopens injection. electron-builder 26.18 quirk: with `'-'` it still looks for a code-signing
identity whose `security find-identity` line contains "-" – a Developer ID or Apple Development
certificate too – and would sign with that instead: no identity name in the
Keychain may contain "-", the build log must say `identityName=-`, and `verify:package` fails unless
`Signature=adhoc`.
Consequences: the Keychain asks once more after every build that changes the app (an identical rebuild
keeps the identity); Playwright's `_electron` cannot attach to the packaged app (E2E, `ui:snap` and
`flow-check` run on `node_modules`' Electron, which keeps its default fuses). Not signed with a
Developer ID, not notarised: a copy on another Mac is blocked by Gatekeeper
(`xattr -dr com.apple.quarantine "/Applications/Glimpse.app"` there, or real signing; README).

**ffmpeg inside the app**: `extraResources` in `electron-builder.yml` copies exactly four files from
`vendor/ffmpeg` to `Contents/Resources/ffmpeg`: `ffmpeg`, `ffprobe` (9.0.2, Apple silicon, a static GPL
v3 build with libx264 that links only system libraries; pinned by URL and sha256 in
`scripts/fetch-ffmpeg.mjs` and `vendor/ffmpeg/SOURCE.txt`), `LICENSE-FFMPEG.txt` (the GPL v3) and
`SOURCE.txt` (where the build and the source code come from). The ad-hoc signing signs the two
binaries like every other binary in the bundle and seals all four files, so a swapped ffmpeg breaks
the app's signature. The app needs macOS 13 (Electron 45) on Apple silicon.

**The zip for friends**: `npm run package:zip` = `npm run package`, then `build/make-zip.mjs`: it
clones `dist/mac-arm64/Glimpse.app` and `build/How to open Glimpse.txt` into a folder `Glimpse`,
checks the copy's signature and writes `dist/Glimpse-<version>.zip` (version from `package.json`)
with `ditto -c -k --keepParent --norsrc`, so the signature, the symlinks and the file modes survive. The text
file tells a friend how to open the unnotarised app, that everyone needs their own Gemini API key,
what macOS asks for, how to update, what goes to Google, and names FFmpeg's licence.

`npm run verify:package` = `node build/verify-package.mjs ["<folder>/Glimpse.app"]` (default
`dist/mac-arm64/…`) checks a packaged app without showing anything: the fuse wire, the asar integrity
data (`Info.plist` hash = sha256 of the asar header, every file against its hashes), the signature
(`codesign --verify --deep --strict`; the hardened runtime on the app and every helper app; exactly
the three entitlements above, so neither `allow-dyld-environment-variables` nor `get-task-allow`), the
ffmpeg inside the app (both binaries executable, version 9.0.2, validly signed, sealed by the app's
signature, the licence and `SOURCE.txt` present), a
hidden start
(`HC_E2E`, fresh profile, fake Gemini, Finder PATH) up to `body[data-ready="true"]` with the app's own
ffmpeg working – seen through the line `[app] ui ready {"ffmpeg":…}` that a packaged `HC_E2E` start
logs (no CDP: the packaged app strips `--remote-debugging-port`, which that start is given to check
that no DevTools endpoint opens) – and that `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`,
`--inspect`, SIGUSR1 and `DYLD_INSERT_LIBRARIES` (a library it builds with the command line tools,
skipped without them) run no code. `--static-only` does the first four without starting the app;
`npm run package` and `package:dmg` end with it. A modified app.asar is not started (Electron refuses
it with a crash and macOS shows a "quit unexpectedly" dialog); the fuse wire and the asar integrity
data cover it statically. Run the full check on a package in a scratch folder while someone may be
using the app in `dist/`.

**Start-up hardening** (`core/early.ts`, runs before everything else): the packaged app removes
`--remote-debugging-port` and `--remote-debugging-pipe` (other programs could drive the window and
`window.api` over CDP), and quits at once (exit code 1)
when `--js-flags` is set (V8 applies it to main before any app code runs; `--trace` would print every
call with its arguments, the API key included) or a launcher switch (`--renderer-cmd-prefix`,
`--gpu-launcher`, `--utility-cmd-prefix`, `--browser-subprocess-path`: they run another program as a
helper). Only the unpackaged app (`app.isPackaged` false: development, E2E, the UI harness) keeps
them; `HC_E2E=1` does not, since any program that starts the app can set it. `NODE_TLS_REJECT_UNAUTHORIZED` is deleted (Node reads
it on every TLS connect, a proxy could then read the key); the Gemini base URL is pinned to Google in
the SDK client and the upload (`GOOGLE_GEMINI_BASE_URL` is ignored).

Remaining risks: (1) the switches are removed by the app's first JavaScript; whether Chromium acts on
any of them before that is checked only by `verify:package`'s hidden start (no DevTools endpoint). (2) With library
validation off, a program that can write into the .app bundle can swap a framework; only Developer ID
signing closes that. (3) `GEMINI_API_KEY`/`GOOGLE_API_KEY` stay the fallback when no key is stored (dev
escape hatch; Settings shows the source). (4) Builds before the fuses were byte-identical stock Electron,
so the Keychain item of the former name, "Highlight Cutter Safe Storage", probably still trusts every
stock Electron binary of those versions; Glimpse no longer uses it (a fresh "Glimpse Safe Storage" item
is created by the first hardened Glimpse build), so delete the old item in Keychain Access. `npm run dev`
runs stock Electron with the same name and item: there answer the Keychain prompt with "Allow", not
"Always Allow", or use `GEMINI_API_KEY`.

## 10. Testing

- Unit: `shared/time`, `core/mutations`, `core/selection`, `core/ipc/validate` (a rejected input per
  check), `ai` normalisation/prompt/error mapping (SDK mocked), media argument builders. A complete,
  valid project loads unchanged (`core/project/store.test.ts`).
- Integration (needs ffmpeg): media service on generated test videos (probe, poster, proxy, sprite, render
  with cut/crossfade, aspect/fit variants, clip without audio) verified with ffprobe – also open-GOP
  HEVC in-points, GPU-scaled proxies against the classic path, and missing permissions. The renders
  use a frame of 360 px short side; one smoke test renders the app's 4K frame (2 clips of 1 s, hard
  cut). 4K is heavy (see §6 Memory): no test renders more than 3 clips or clips longer than 1 s at
  4K – the E2E flows trim their reels to 3 × 1 s before they export (`shortenReel`).
- Core: job manager with fake media/analyzer (prepare → analyse → autoSelect or a kept hand-edited reel,
  no-op start, cancel, errors, remedies, per-video run summaries, uploads on Google's side, free-space
  checks with a fake disk, the order of flushes and toasts); `quitDuringProcessing.test.ts` wires the
  real Gemini analyzer (fake SDK and upload server) into the job manager and quits while Gemini still
  processes an upload.
- AI: the uploader against a fake server with timed outages, stalls and lost answers. The live Gemini
  test runs only on request (`GEMINI_API_KEY=… npm run test:live`).
- Renderer: `lib/*` and the store as unit tests (`store/export-basis.test.ts`: which reel a finished
  export describes). What a screen says in a given state is checked by rendering it to a string
  (`renderToStaticMarkup`, e.g. `screens/analysis/AnalysisStep.test.ts`); effects do not run there
  and `useApp` returns its initial state, so a test that needs store state mocks `store/app-store`.
- UI snapshots and `flow-check` (mock API), E2E (`HC_FAKE_AI=1`, real ffmpeg, stubbed dialogs; the
  first start with `HC_FAKE_AI_REQUIRE_KEY=1`), and `npm run verify:package` for a packaged app. A
  failed E2E test leaves full diagnostics in its `test-results/` folder: `main.log`, the main process
  output, the renderer console, a screenshot and a Playwright trace per launch (the next run empties
  the folder).
- Every app launch from a test or an agent stays hidden: `HC_E2E=1`, a fresh `HC_USER_DATA_DIR`,
  `HC_FAKE_AI=1` and a temp `HC_OUTPUT_DIR`; never the real profile or the Keychain.
- By hand only (they show a window or need a real logout): the quit question (⌘Q or the Dock's
  "Quit" during an analysis or export; Esc = "Keep working"), ⌘W and reopening from the Dock (a
  toast held meanwhile arrives with its project's name), logout without a question (`quit.test.ts`
  covers only the decision: ask, wait for the open question, shut down, quit). `early.test.ts`
  covers the start-up hardening; the packaged non-E2E start itself is not run.
