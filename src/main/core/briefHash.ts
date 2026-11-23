import { createHash } from 'node:crypto'
import type { BriefSettings } from '@shared/types'

function sha1(fields: Record<string, unknown>): string {
  return createHash('sha1').update(JSON.stringify(fields)).digest('hex').slice(0, 12)
}

/**
 * Identifies what influences an analysis: the prompt and the model (docs/ARCHITECTURE.md §4). The
 * target length is deliberately not part of it – selection handles that. The prompt counts as Gemini
 * gets it: trimmed, so a trailing space or line break does not make every video stale. Mirrored by
 * the renderer (src/renderer/src/lib/brief-hash.ts), so keep the key order.
 */
export function briefHash(brief: BriefSettings, model: string): string {
  return sha1({ prompt: brief.prompt.trim(), model })
}

/**
 * The hashes older builds stored for `prompt`: they also hashed the clip lengths and the analysis
 * quality that `storedBrief` (the brief as read from the project file) still holds, the oldest ones
 * the prompt as typed. Only to recognise their analyses (project/normalize.ts migrates them).
 */
export function legacyBriefHashes(
  prompt: string,
  storedBrief: Record<string, unknown>,
  model: string
): string[] {
  const { minClipSec, maxClipSec, analysisQuality } = storedBrief
  return [prompt.trim(), prompt].map((text) =>
    sha1({ prompt: text, minClipSec, maxClipSec, analysisQuality, model })
  )
}

/**
 * Every hash those builds could have stored for `prompt`: all values their clip-length steppers
 * (shortest 1–30 s, longest 2–60 s, in half seconds) and quality cards allowed. Recognises an
 * analysis made before the user changed one of those options without analysing again – the options
 * are gone, so only another prompt or model makes it stale. About 32 000 hashes, some 40 ms.
 */
export function legacyOptionHashes(prompt: string, model: string): Set<string> {
  const hashes = new Set<string>()
  for (const text of new Set([prompt.trim(), prompt]))
    for (const analysisQuality of ['fast', 'balanced', 'detailed'])
      for (let minClipSec = 1; minClipSec <= 30; minClipSec += 0.5)
        for (let maxClipSec = Math.max(2, minClipSec); maxClipSec <= 60; maxClipSec += 0.5)
          hashes.add(sha1({ prompt: text, minClipSec, maxClipSec, analysisQuality, model }))
  return hashes
}
