# Glimpse

Glimpse (repo and package: `glimpse`) is a macOS Electron app: Meta-glasses videos → Gemini
finds highlight moments → user reviews → ffmpeg renders a highlight video.
Spec: `docs/ARCHITECTURE.md`. Current Gemini API facts: `docs/research/gemini.md` (trust it over memory).

## Commands

- `npm run typecheck` · `npm test` (vitest, uses `vendor/ffmpeg`; never calls Gemini) · `npm run dev`
- `node scripts/fetch-ffmpeg.mjs`: once per checkout, puts the pinned ffmpeg and ffprobe into
  `vendor/ffmpeg` (git-ignored). `npm run package:zip`: the app plus `dist/Glimpse-<version>.zip` for friends.
- `npm run ui:snap` (UI screenshots with mock API → `artifacts/ui/`, 1440×900 and 1100×720) ·
  `npm run test:e2e` · `npm run package` · `npm run verify:package` (checks a packaged app)
- `GEMINI_API_KEY=… npm run test:live`: the only real Gemini call (uploads a clip, uses quota) – only
  when asked. `GEMINI_API_KEY` alone does not run it.

## Conventions

- TypeScript strict, no `any` unless unavoidable; Prettier style: single quotes, no semicolons, width 100.
- Contracts: `src/shared/types.ts`, `src/shared/ipc.ts`, `src/main/contracts.ts` – change only deliberately.
- All user-facing text is English (British spelling, "you"), plain and friendly, sentence case; no German
  left in the UI, formats via `en-GB`. Code, comments, logs in English. Terms: the reel is the "highlight
  video" (never "reel" in the UI), "API key", "billing"; steps Videos, Prompt, Analysis, Edit, Export.
- Design: "cinematic neutral" – graphite greys with one lime accent (`#c5f03c` dark, `#3d6600` light),
  dark and light theme following macOS, video areas always dark; colours via the tokens in
  `styles/tokens.css` (fixed black scrims and white on video, and the app icon/mark, excepted). Font
  Montserrat (bundled), headlines bold.
- Main process owns all state; renderer edits projects only via `mutateProject` and listens to `onProjectUpdated`.
- Never log or send the Gemini API key to the renderer.
- The name is "Glimpse" everywhere (`APP_NAME` in `src/main/core/appIdentity.ts`, `productName` in
  `package.json` and `electron-builder.yml`, bundle id `de.janfabig.glimpse`). The data folder and the
  Keychain entry of the API key are built from it – renaming it orphans users' projects and keys
  unless a move like `moveLegacyUserData` comes with it.
- ffmpeg/ffprobe: the app ships its own (`vendor/ffmpeg` → `Contents/Resources/ffmpeg`). The packaged
  app uses only that copy; development, tests, E2E and scripts take `HC_FFMPEG`/`HC_FFPROBE`, then
  `vendor/ffmpeg`, then Homebrew (`toolchain.ts`, `devBinary()` in `testVideos.ts`). Always explicit paths.
  The renderer tells development from the packaged app by the command in main's missing-ffmpeg text
  (`node scripts/fetch-ffmpeg.mjs`: `media/errors.ts`, `renderer/src/lib/system.ts`, the mock's copy).
- Every export is 4K (`EXPORT_FIXED` in `src/shared/presets.ts`) and each ffmpeg run needs gigabytes
  of memory – but the same for any number of clips: no run opens more than two clips, also for
  crossfades; keep it so (`docs/ARCHITECTURE.md` §6 Memory). Media tests pass a small frame (`RenderJob.frame`, 360 px); at 4K
  never render more than 3 clips or clips longer than 1 s in a test (E2E: `shortenReel`). Measure
  ffmpeg's memory as footprint, not RSS – macOS compresses what does not fit.
- Launching the app from tests or scripts: always hidden and isolated – `HC_E2E=1`, a fresh
  `HC_USER_DATA_DIR`, `HC_FAKE_AI=1`, a temp `HC_OUTPUT_DIR`; never the real profile or the Keychain.
  First-start E2E: add `HC_FAKE_AI_REQUIRE_KEY=1` (fake analyzer, but a key is required).
- Some texts of main are matched elsewhere: the missing-original text (`renderer/src/lib/project.ts`;
  `fromGermanBuild` in `core/project/normalize.ts` turns the German one old projects store into it), media's full-export-folder
  text (`folderFullMessage` in `core/errors.ts`), the retry hint (`OFFERS_RETRY` in `core/jobs/analysis.ts`)
  and the mock's copies (`renderer/src/api/mock-messages.ts`) – change them together.
  Toasts that must stay until closed are marked by main (`ToastEvent.sticky`, `TOAST_KEYS`), not by text.
