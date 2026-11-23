# Gemini API – verified facts (researched 2026-11-01)

Sources: ai.google.dev docs (models page 2026-10-28, pricing 2026-10-30, terms 2026-03-23), `@google/genai`
2.32.0 typings + SDK source, checks against a local mock server. **No live API call was made** (no key) –
re-verify behaviour on the first real run. Prefer these notes over memory.

## Models (Developer API, API key)

| id                      | status                | use in app     | price / 1M tokens (in / out, thinking billed as out) | thinking levels                                    |
| ----------------------- | --------------------- | -------------- | ---------------------------------------------------- | -------------------------------------------------- |
| `gemini-3.8-flash`      | stable, free tier     | **default**    | $0.75 / $3.75 until 2026-12-31, then $1.50 / $7.50   | low, medium (default), high – **`minimal` errors** |
| `gemini-4-argon`        | stable, **paid only** | "best quality" | $2 / $10 until 2026-11-30, then $4 / $20             | low, medium (default), high – cannot be off        |
| `gemini-3.6-flash`      | stable, free tier     | alternative    | as 3.8 Flash                                         | minimal … high                                     |
| `gemini-3.5-flash-lite` | stable, free tier     | "low cost"     | $0.30 / $2.50                                        | minimal (default) … high → send ≥ `low`            |

- Not for new apps: 2.5 models (only accounts that used them before, since 2026-09-18), 2.0 + several
  previews are shut down; `gemini-3-flash-preview` is legacy; `gemini-3.1-pro-preview` is paid only.
- `-latest` aliases exist but their targets are undocumented → pin explicit ids.
- `models.list()` (Pager, `for await`) also returns TTS/image/etc. models → filter by an allow-list/pattern
  plus `supportedActions` containing `generateContent`.
- Sampling params (`temperature`, `topP`, `topK`) are deprecated from 3.6 Flash / 3.5 Flash-Lite on:
  ignored now, 400 in future models → **don't send them**. `candidateCount` unsupported.

## Free tier, billing, data use

- Free-tier limits are only shown in AI Studio (third-party, unverified: 3.8 Flash ≈ 5 RPM / 20 requests
  per day; Flash-Lite ≈ 10 RPM / 500 per day). A festival with 20+ clips can hit the daily cap → clear
  message suggesting Flash-Lite, waiting, or enabling billing.
- Paid tier: link billing + prepay ≥ $5 (a $0 prepay balance → HTTP **402** on all keys).
- Free tier content may be used to improve products incl. human review; paid tier not. **EEA (user is in
  Germany): the paid-tier data terms apply to free quota too**; the terms still ask not to send personal
  data to unpaid services.
- `store: false` in `GenerateContentConfig` (SDK ≥ 2.31) disables request logging/storage (paid projects
  created since 2026-10-26 store by default) → **always send `store: false`**.

## Video input

- Default processing = static, **1 fps**, one timestamp inserted per second, audio track is used (mono, low
  bitrate) → music, cheering, laughter, speech count.
- Set `mediaProcessing: MediaProcessing.STATIC` explicitly on the video part (docs are ambiguous about the
  default; fps/offsets only work in static mode). Agentic mode: not for ≤ 5-min clips.
- Part: `{ fileData: { fileUri, mimeType }, mediaProcessing: MediaProcessing.STATIC, videoMetadata: { fps,
startOffset?: '40s', endOffset?: '80s' } }` – fps in (0, 24], offsets are strings with `s` suffix.
- Tokens on Gemini 3/4: video frames 70 tokens each at LOW/MEDIUM/unspecified, 280 at HIGH; audio ≈ 25
  tokens/s (docs contradict each other – measure `usageMetadata`). 5-min clip at 1 fps ≈ 30 k tokens →
  ≈ $0.02 input on 3.8 Flash; at HIGH ≈ 90 k. **fps is the main cost lever**; LOW vs MEDIUM makes no
  difference for video on Gemini 3/4.
- `config.mediaResolution = MediaResolution.MEDIA_RESOLUTION_LOW | _MEDIUM | _HIGH` (global, works
  everywhere; per-part `mediaResolution: { level }` exists but is experimental – use global).
- Put the video part **first**, text after it.
- Supported mime: `video/mp4` (our analysis copy of the proxy). The SDK has no `.mov` mapping.
- Timestamps: ask for `MM:SS` (or `MM:SS.sss` when fps > 1). No accuracy figure is published; expect ≈ 1 s
  at 1 fps. Known failure modes: stamps beyond the end, malformed (`0:65`), clips bunched at the start, too
  few clips, invented answers when the video was not actually seen.

## Files API

- 2 GB per file, 20 GB per project, auto-deleted after **48 h**, free. States: `STATE_UNSPECIFIED`,
  `PROCESSING`, `ACTIVE`, `FAILED` (`FileState` enum). Poll `files.get({ name })` every 2–3 s until ACTIVE
  (keep polling on STATE_UNSPECIFIED; tolerate a transient network error while polling); FAILED →
  `file.error?.message`. File has `uri`, `name`, `mimeType`, `expirationTime`, `sizeBytes`.
- `files.upload({ file: string | Blob, config: { mimeType, displayName } })`: **no progress callback, its
  `abortSignal` is ignored, passing `config.httpOptions` breaks it, and a path with a non-Latin-1 file
  name throws** → if used, pass `await fs.openAsBlob(path, { type: 'video/mp4' })` + `displayName`.
- Preferred: own resumable uploader with `fetch` for progress + cancel (same wire protocol the SDK uses,
  verified against a mock):
  1. `POST https://generativelanguage.googleapis.com/upload/v1beta/files` with headers
     `x-goog-api-key`, `Content-Type: application/json`, `X-Goog-Upload-Protocol: resumable`,
     `X-Goog-Upload-Command: start`, `X-Goog-Upload-Header-Content-Length: <bytes>`,
     `X-Goog-Upload-Header-Content-Type: video/mp4`; body `{"file":{"displayName":"…"}}` → response header
     `x-goog-upload-url`.
  2. Per 8 MiB chunk (multiple of 256 KiB except the last): `POST <upload url>` with `x-goog-api-key`,
     `X-Goog-Upload-Command: upload` (last: `upload, finalize`), `X-Goog-Upload-Offset: <offset>`, raw
     bytes → `x-goog-upload-status: active` (`final` on the last; body `{ "file": File }`).
     Fall back to `files.upload` (Blob) if the custom uploader fails with a protocol error (not network/abort).
     Reference implementation: `<scratchpad>/research/genai/src/resumable-upload.ts`.
- `files.delete({ name, config: { httpOptions: { timeout: 15000, retryOptions: { attempts: 1 } } } })` so
  cleanup can never hang; ignore 404.

## generateContent request (SDK 2.32)

```ts
const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 10 * 60_000 } }) // Argon: ≥ 20 min
const res = await ai.models.generateContent({
  model,
  contents: [{ role: 'user', parts: [videoPart, { text: userPrompt }] }],
  config: {
    systemInstruction,
    responseMimeType: 'application/json',
    responseJsonSchema: schema, // don't also set responseSchema
    thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM }, // never MINIMAL on 3.8 Flash / Argon
    mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
    maxOutputTokens: 32768, // thinking counts against it; too low → MAX_TOKENS + broken JSON
    store: false,
    abortSignal // per-call AbortSignal (SDK leaves listeners on reused signals)
  }
})
```

- `res.text` excludes thought parts. Check `res.candidates?.[0]?.finishReason` (`STOP` ok; `MAX_TOKENS`;
  `SAFETY` / `PROHIBITED_CONTENT` / `BLOCKLIST` → safety) and `res.promptFeedback?.blockReason`.
- `res.usageMetadata`: `promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `totalTokenCount`,
  `promptTokensDetails[{ modality: 'VIDEO' | 'AUDIO' | 'TEXT', tokenCount }]` → sanity check that VIDEO
  tokens are ≥ ~40 % of `duration × fps × 70`; otherwise the model did not see the video → retry/error.
- Strip a leading ` ```json ` fence defensively before `JSON.parse`.
- Schema: JSON-Schema subset. Output keys follow schema order. **No `pattern`**; `minLength`, `maxLength`,
  `uniqueItems` … are ignored; `minItems`/`maxItems` are enforced; numeric `minimum`/`maximum` and large
  schemas can cause 400 "too many states" → keep it small, validate on the client.
- Implicit caching: keep the system instruction byte-identical; video first.

## Errors (SDK)

- `ApiError` with `.status`; `.message` contains the JSON error body → parse for `google.rpc.RetryInfo`
  `retryDelay` and `QuotaFailure` `quotaId` (contains `PerDay` → daily cap, don't retry; per-minute →
  wait `retryDelay`, which can be misleading – use a minimum backoff).
- Status mapping: 400 with "API key not valid" / 401 / 403 → `auth`; 402 → billing (prepay empty);
  404 → `model`; 429 → `quota`; 408/500/502/503/504 → retry (`network`); safety → `safety`.
- Connection drops surface as `TypeError: fetch failed` (undici, `cause.code` e.g. `ECONNRESET`,
  `ENOTFOUND`, `UND_ERR_SOCKET`) and are **not** retried by the SDK → retry in app code (festival Wi-Fi!).
- Timeouts and aborts throw a DOMException named `AbortError` → distinguish via your own signal.
- SDK `retryOptions` also retries timed-out attempts (worst case attempts × timeout) → prefer app-level
  retries (max 4 attempts, exponential backoff with jitter, abortable sleeps) and no SDK retries.

## Prompting recommendations (highlight research)

- Fixed system instruction (rules, absolute score scale, quality rules, "the brief overrides the default
  rules"), then: video part → metadata text (file name, recording time, exact duration, last valid
  timestamp) → the user's brief last.
- Absolute score scale: 10 unmissable · 7–9 strong · 4–6 ok filler · 1–3 weak.
- Schema idea: `{ videoEndsAt: "MM:SS", moments: [{ start, peak, end, title, reason, score }] }`
  with `minItems: 1`, `maxItems ≈ min(15, ceil(duration / 20))` (the app asks for fewer, see
  ARCHITECTURE §7). `peak` lets the client fit the clip
  length around the key instant; `videoEndsAt` is a sanity check (mismatch + overrunning stamps → retry).
- Client validation: parse robustly (MM:SS, M:SS, H:MM:SS, decimals, plain seconds; `0:65` overflow →
  treat as 65 s), swap reversed start/end, drop clips starting after the end, clamp to duration, keep the
  peak inside, fit to [min, max] around the peak, merge/trim overlaps (keep higher score), retry once when
  > 30 % of candidates are broken.
- Cost hints for the UI (3.8 Flash, 5-min clip): 1 fps, medium resolution, medium thinking (what the
  app sends) ≈ 3–6 ct · 1 fps, low thinking ≈ 2–4 ct · 2 fps, HIGH resolution, high thinking ≈ 15–25 ct.
