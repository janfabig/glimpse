// Mirrors the brief hash computed in main (src/main/core/briefHash.ts, docs/ARCHITECTURE.md §4) so
// the UI can tell which videos would be re-analysed after the brief or the model changed. The
// prompt is hashed trimmed, as Gemini gets it.

import type { BriefSettings, Project } from '@shared/types'

export async function briefHash(brief: BriefSettings, model: string): Promise<string> {
  const json = JSON.stringify({ prompt: brief.prompt.trim(), model })
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(json))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12)
}

/** mirrors main's rule: a failed, cancelled or interrupted attempt makes the video a target again */
export function isAnalysisFresh(project: Project, videoId: string, currentHash: string): boolean {
  const analysis = project.analyses[videoId]
  return analysis?.briefHash === currentHash && !lastAttemptFailed(project, videoId)
}

export function lastAttemptFailed(project: Project, videoId: string): boolean {
  const stage = project.status[videoId]?.analysis.stage
  return stage === 'error' || stage === 'cancelled'
}
