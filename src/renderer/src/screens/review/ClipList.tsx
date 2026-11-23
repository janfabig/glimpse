import { useRef, useState, type DragEvent } from 'react'
import { ChevronDown, ChevronUp, GripVertical, X } from 'lucide-react'
import type { Moment, MomentId, VideoInfo } from '@shared/types'
import { IconButton } from '../../components/ui/Button'
import { Frame } from '../../components/ui/Frame'
import { isRepeatClick } from '../../lib/click-guard'
import { cx } from '../../lib/dom'
import { formatSeconds, tc } from '../../lib/format'
import { reorderTarget, type TimeRange } from '../../lib/moments'
import { useScrollIntoView } from './use-scroll-into-view'

const DRAG_TYPE = 'application/x-highlight-moment'

export interface ClipListProps {
  clips: Moment[]
  videos: Map<string, { video: VideoInfo; index: number }>
  activeId: MomentId | null
  previewingId: MomentId | null
  /** main is changing the clip right now (e.g. taking it out): disabled until it answers */
  isPending: (id: MomentId) => boolean
  timesOf: (moment: Moment) => TimeRange
  onActivate: (id: MomentId) => void
  onRemove: (id: MomentId) => void
  onMove: (id: MomentId, toIndex: number) => void
}

/** the selected clips in output order: drag & drop or up/down to reorder */
export function ClipList({
  clips,
  videos,
  activeId,
  previewingId,
  isPending,
  timesOf,
  onActivate,
  onRemove,
  onMove
}: ClipListProps): React.JSX.Element {
  const [dragId, setDragId] = useState<MomentId | null>(null)
  const [slot, setSlot] = useState<number | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  // also when the active clip moves up or down in the list
  const activeIndex = clips.findIndex((clip) => clip.id === activeId)
  useScrollIntoView(listRef, '.clip.is-active', [activeId, activeIndex])

  const isMomentDrag = (event: DragEvent): boolean => event.dataTransfer.types.includes(DRAG_TYPE)

  const overItem =
    (index: number) =>
    (event: DragEvent<HTMLLIElement>): void => {
      if (!isMomentDrag(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      const rect = event.currentTarget.getBoundingClientRect()
      setSlot(event.clientY < rect.top + rect.height / 2 ? index : index + 1)
    }

  const drop = (event: DragEvent): void => {
    if (!isMomentDrag(event)) return
    event.preventDefault()
    const id = event.dataTransfer.getData(DRAG_TYPE)
    const from = clips.findIndex((clip) => clip.id === id)
    if (from >= 0 && slot !== null) {
      const toIndex = reorderTarget(from, slot, clips.length)
      if (toIndex !== null) onMove(id, toIndex)
    }
    setDragId(null)
    setSlot(null)
  }

  return (
    <ol
      ref={listRef}
      className="clip-list"
      onDragOver={(event) => {
        if (isMomentDrag(event)) event.preventDefault()
      }}
      onDrop={drop}
      aria-label="Clips in the highlight video"
    >
      {clips.map((clip, index) => {
        const entry = videos.get(clip.videoId)
        const times = timesOf(clip)
        const pending = isPending(clip.id)
        return (
          <li
            key={clip.id}
            className={cx(
              'clip',
              pending && 'is-pending',
              clip.id === activeId && 'is-active',
              clip.id === previewingId && 'is-previewing',
              clip.id === dragId && 'is-dragging',
              slot === index && dragId !== null && 'drop-before',
              slot === clips.length && index === clips.length - 1 && dragId !== null && 'drop-after'
            )}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(DRAG_TYPE, clip.id)
              event.dataTransfer.effectAllowed = 'move'
              setDragId(clip.id)
            }}
            onDragOver={overItem(index)}
            onDragEnd={() => {
              setDragId(null)
              setSlot(null)
            }}
            data-testid="clip-item"
            data-moment-id={clip.id}
            aria-busy={pending || undefined}
          >
            <span className="clip__grip" aria-hidden>
              <GripVertical size={14} />
            </span>
            <button
              type="button"
              className="clip__main"
              onClick={() => onActivate(clip.id)}
              aria-current={clip.id === activeId ? 'true' : undefined}
            >
              <span className="clip__thumb">
                <Frame
                  video={entry?.video ?? null}
                  time={times.start + 0.5}
                  width={40}
                  height={52}
                />
                <span className="clip__num num">{index + 1}</span>
              </span>
              <span className="clip__info">
                <span className="clip__title">{clip.title}</span>
                <span className="clip__meta num">
                  Video {(entry?.index ?? 0) + 1} · {tc(times.start, 1)} ·{' '}
                  {formatSeconds(times.end - times.start)}
                </span>
              </span>
            </button>
            <span className="clip__actions">
              <IconButton
                icon={ChevronUp}
                size="sm"
                label="Move earlier"
                disabled={index === 0}
                onClick={(event) => {
                  // the rows swap right away: a second click must not move the neighbour back
                  if (!isRepeatClick(event)) onMove(clip.id, index - 1)
                }}
                data-testid="clip-move-up"
              />
              <IconButton
                icon={ChevronDown}
                size="sm"
                label="Move later"
                disabled={index === clips.length - 1}
                onClick={(event) => {
                  if (!isRepeatClick(event)) onMove(clip.id, index + 1)
                }}
                data-testid="clip-move-down"
              />
              <IconButton
                icon={X}
                size="sm"
                variant="danger"
                label="Remove from the highlight video (X)"
                disabled={pending}
                onClick={(event) => {
                  // the list moves up right away: a double click must not take the next clip too
                  if (!isRepeatClick(event)) onRemove(clip.id)
                }}
                data-testid="clip-toggle"
              />
            </span>
          </li>
        )
      })}
    </ol>
  )
}
