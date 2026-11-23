import { useCallback, useEffect, useRef, useState } from 'react'
import type { BriefSettings } from '@shared/types'
import { briefHash } from '../../lib/brief-hash'

/** current brief hash (async, SHA-1 via WebCrypto); null while computing */
export function useBriefHash(brief: BriefSettings, model: string | undefined): string | null {
  const [hash, setHash] = useState<{ key: string; value: string } | null>(null)
  const key = JSON.stringify([brief.prompt, model])
  useEffect(() => {
    if (!model) return
    let cancelled = false
    void briefHash(brief, model).then((value) => {
      if (!cancelled) setHash({ key, value })
    })
    return () => {
      cancelled = true
    }
    // the key covers every input of the hash
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return hash?.key === key ? hash.value : null
}

/**
 * Local draft for a text field that is persisted with a debounce. External changes replace the
 * draft only while the user has no unsaved edits.
 */
export function useDraft(
  value: string,
  commit: (next: string) => Promise<unknown>,
  delayMs = 600
): {
  draft: string
  change: (next: string) => void
  flush: () => Promise<void>
} {
  const [draft, setDraft] = useState(value)
  const latest = useRef(value)
  const dirty = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const commitRef = useRef(commit)
  useEffect(() => {
    commitRef.current = commit
  })

  useEffect(() => {
    if (!dirty.current) {
      latest.current = value
      setDraft(value)
    }
  }, [value])

  const flush = useCallback(async (): Promise<void> => {
    window.clearTimeout(timer.current)
    if (!dirty.current) return
    dirty.current = false
    await commitRef.current(latest.current)
  }, [])

  const change = useCallback(
    (next: string): void => {
      latest.current = next
      dirty.current = true
      setDraft(next)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void flush(), delayMs)
    },
    [delayMs, flush]
  )

  useEffect(() => () => void flush(), [flush])

  return { draft, change, flush }
}
