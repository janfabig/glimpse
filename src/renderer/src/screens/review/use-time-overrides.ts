import { useCallback, useRef, useState } from 'react'
import type { Moment, MomentId } from '@shared/types'
import type { TimeRange } from '../../lib/moments'
import { mutate } from '../../store/actions'

/**
 * Optimistic in/out points: trims show up immediately (also while dragging) and are committed
 * to main with updateMomentTimes. The override is dropped once the latest commit has returned.
 */
export function useTimeOverrides(): {
  timesOf: (moment: Moment) => TimeRange
  /** shows a draft; null drops it */
  preview: (id: MomentId, range: TimeRange | null) => void
  commit: (id: MomentId, range: TimeRange) => Promise<void>
} {
  const [overrides, setOverrides] = useState<Record<MomentId, TimeRange>>({})
  const sequence = useRef<Record<MomentId, number>>({})

  const timesOf = useCallback(
    (moment: Moment): TimeRange => overrides[moment.id] ?? { start: moment.start, end: moment.end },
    [overrides]
  )

  const preview = useCallback((id: MomentId, range: TimeRange | null): void => {
    // a draft is newer than any commit under way: its return must not drop the draft
    if (range) sequence.current[id] = (sequence.current[id] ?? 0) + 1
    setOverrides((current) => {
      const next = { ...current }
      if (range) next[id] = range
      else delete next[id]
      return next
    })
  }, [])

  const commit = useCallback(
    async (id: MomentId, range: TimeRange): Promise<void> => {
      preview(id, range)
      const seq = (sequence.current[id] ?? 0) + 1
      sequence.current[id] = seq
      await mutate({ type: 'updateMomentTimes', momentId: id, start: range.start, end: range.end })
      if (sequence.current[id] === seq) preview(id, null)
    },
    [preview]
  )

  return { timesOf, preview, commit }
}
