# Glimpse

A Mac app that automatically cuts a highlight video from your Meta glasses videos (a festival, a
concert, a night out with friends). You write a prompt, **Gemini** watches every video and suggests the
best moments with timestamps. You review and trim the clips, and **ffmpeg** renders the finished
video, for example in the 9:16 format for Reels.

## Quick start

1. Get a Gemini API key: <https://aistudio.google.com/apikey>
2. Install the dependencies and fetch ffmpeg (once):
   ```bash
   npm install
   node scripts/fetch-ffmpeg.mjs
   ```
3. Build the app:
   ```bash
   npm run package
   ```
   The app is then in `dist/mac-arm64/Glimpse.app`. Drag it into your Applications folder. It runs
   on the Mac you built it on; to give it to others, see “Share it with friends”.
4. Open the app → “Connect Gemini” → paste your API key → “Connect”. The app tests the key and saves
   it only when Google accepts it. You can change it later with the gear button (Settings).
5. “New highlight video” → drag in videos or a whole folder → write your prompt → “Analyse with
   Gemini” → review the clips → “Create highlight video”.

ffmpeg is part of the app: `node scripts/fetch-ffmpeg.mjs` (step 2) downloads the pinned ffmpeg and
ffprobe 9.0.2 into `vendor/ffmpeg` (checksums are checked), and `npm run package` puts them into the
app. Nothing has to be installed with Homebrew.

Not happy with the suggestions? In the Edit step, “Ask Gemini again” starts a second pass: you write
in one sentence what Gemini should do differently. The sentence is added as a new line at the end of
your prompt, Gemini looks at all your videos again (one request per video) and sees the clips it
chose before. Its earlier suggestions and your changes to them are replaced, and your highlight video
is put together again.

When you export, you only choose the format, the fit, the transition and the export folder. Every
highlight video is rendered in 4K (30 frames per second, H.264), faded in and out gently and
levelled in loudness. Rendering takes about three to eight times as long as the video and needs a lot
of memory.

## Share it with friends

```bash
npm run package:zip
```

builds the app and then `dist/Glimpse-<version>.zip`: a folder `Glimpse` with `Glimpse.app` and
`How to open Glimpse.txt`. Send the zip. Your friend needs a Mac with Apple silicon and macOS 13 or
later, and their own free Gemini API key; ffmpeg is inside the app. The text file explains the rest:
the app is not notarised by Apple, so macOS blocks it once ("Open Anyway" in System Settings, or one
Terminal line). There is no self-update: send a new zip, the app is replaced, projects and settings
stay. Glimpse includes FFmpeg under the GPL v3; its licence travels inside the app.

## Getting the videos from the glasses to the Mac

- The Meta AI app imports the clips to your iPhone (Photos).
- From there by AirDrop (Options → “All Photos Data”) or through iCloud Photos → Photos for Mac →
  File → Export → “Export Unmodified Original”.
- Tip: export the clips of one evening into a folder of their own and drag the whole folder into the
  app. It takes every video directly inside it (not in subfolders) and sorts them by recording time.
- Tip: for 5-minute clips, record at 1080p/30 fps on the glasses (3K and 60 fps are limited to 3 min).

## Cost and privacy

- Default model: Gemini 3.8 Flash. With billing turned on, a video of about 5 minutes costs about
  3–6 cents. From 1 Jan 2027 Google doubles the prices of this model. The app shows the cost for your
  model in the Prompt step before you start the analysis.
- Free quota: without billing the analysis costs nothing but is limited, with 3.8 Flash to about
  20 analyses a day (figure from third parties; Google AI Studio shows the exact limit). Gemini 3.5
  Flash-Lite allows a lot more for free (about 500 a day, according to third parties) but is a little
  less accurate. For a whole festival day, billing in Google AI Studio is worth it (prepaid from $5).
- Only a lean 720p copy of each video is uploaded (4 pictures per second, mono sound, no location
  data), never your original. It stays at Google for up to 48 hours for another analysis and is then
  deleted automatically. When you remove the video or the project, the app deletes it right away.
- In the EU the privacy terms of the paid tier apply to the free quota too. Google still asks not to
  send personal data to free services, so for footage with other people, use an API key with billing
  turned on.
- Requests are sent with `store: false` (no logging at Google).
- The API key is stored encrypted in the macOS Keychain and never leaves the app's main process.

## Development

| Command                  | Purpose                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| `npm run dev`            | The app with hot reload                                                     |
| `npm test`               | Unit and ffmpeg integration tests (no real Gemini call)                     |
| `npm run test:live`      | Live test against the real Gemini API (see below)                           |
| `npm run typecheck`      | Check the TypeScript                                                        |
| `npm run ui:snap`        | Screenshots of all screens with mock data (`artifacts/ui/`)                 |
| `npm run test:e2e`       | End-to-end test of the built app (no real Gemini call)                      |
| `npm run package`        | Build the `.app` (with fuses, signed ad hoc, hardened runtime) and check it |
| `npm run verify:package` | Check a built app fully: fuses, signature, a start in the background        |
| `npm run package:zip`    | Build the app and the zip for friends (`dist/Glimpse-<version>.zip`)        |

The live test uploads a short test clip to Google and uses quota. So it only runs when you start it
on purpose:

```bash
GEMINI_API_KEY=your-key npm run test:live
```

`GEMINI_API_KEY` alone is not enough (`npm test` skips the test), because the app also uses the
variable as the key when none is saved.

`npm run dev` runs with the stock Electron and uses the same Keychain entry as the app. When macOS
asks for the Keychain there, click only “Allow” (not “Always Allow”), or set the key for development
with `GEMINI_API_KEY`.

Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Research on the Gemini API:
[docs/research/gemini.md](docs/research/gemini.md).

## Problems?

- **“Glimpse is damaged”** → the ffmpeg inside the app is missing or does not start. Replace the app
  with a fresh copy (build it again or unzip it again). **“ffmpeg is missing”** appears only in a
  development build → `node scripts/fetch-ffmpeg.mjs`.
- **Keychain prompt after a new build** → “Always Allow”. The app has no Apple certificate (only an
  ad-hoc signature), so macOS asks again once after every build that changes the app for access to
  “Glimpse Safe Storage”. Your projects, settings and API key are kept.
- **Asked for the API key again after updating from Highlight Cutter** (the app’s former name) → the
  first start moves your projects and settings to `~/Library/Application Support/Glimpse`, but the
  key was locked to the old Keychain entry: paste it once more. You can then delete the old entry
  “Highlight Cutter Safe Storage” in Keychain Access.
- **“Your saved API key can no longer be read”** → paste the key again on the home screen or in
  Settings. This happens for example when access to the Keychain was denied.
- **Opening the app on another Mac** → the app is neither signed by Apple nor notarised. If you pass
  it on (AirDrop, download, DMG), macOS blocks it there. On the other Mac this helps once:
  ```bash
  xattr -dr com.apple.quarantine "/Applications/Glimpse.app"
  ```
  The clean solution would be signing with an Apple Developer ID plus notarisation.
- **“Your daily Gemini quota is used up”** → continue tomorrow, switch to “Gemini 3.5 Flash-Lite” in
  Settings or turn on billing. For every failed video, the Analysis step says what helps, with the
  right button. Then restart the affected videos with “Try again”; the finished ones stay as they are.
- **“API key rejected”** in Settings → Google no longer accepts your saved key (for example, it was
  deleted in AI Studio). Create a new one there and paste it in Settings.
- **“There is not enough free space on your Mac”** → free up space and try again. The app keeps saving
  your project changes automatically as soon as there is space again; until then the warning “Your
  changes cannot be saved right now” stays.
- **“There is not enough free space in the export folder …”** → the export folder is on another drive
  (for example an external SSD) and that drive is full. Free up space there or choose another export
  folder when you export; space on the Mac does not help here.
- **“An export is already running in another project”** → with 8 GB of memory the app renders one
  highlight video after the other. Start the export again once the other one is finished.
- **“… was damaged and was restored from the last backup”** → every time it saves, the app keeps the
  previous version of a project and loads it when the project file is damaged (for example after a
  crash). The latest changes may then be missing.
- **Something else went wrong?** → you find the log file in Settings → System → “Show log file in
  Finder” (`~/Library/Application Support/Glimpse/logs/main.log`). Your API key is never in it.

## Licence

Glimpse is under the [MIT licence](LICENSE). The bundled FFmpeg (fetched into `vendor/ffmpeg`, not part
of this repository) is under the GPL v3: see `vendor/ffmpeg/LICENSE-FFMPEG.txt` and `SOURCE.txt`.
Glimpse is a personal project and is not affiliated with Meta or Google.
