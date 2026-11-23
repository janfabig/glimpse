import { useRef } from 'react'
import { Plus, Star } from 'lucide-react'
import type { Moment, MomentId, Project } from '@shared/types'
import { IconButton } from '../../components/ui/Button'
import { Frame } from '../../components/ui/Frame'
import { isRepeatClick } from '../../lib/click-guard'
import { cx } from '../../lib/dom'
import { formatSeconds, tc } from '../../lib/format'
import type { TimeRange } from '../../lib/moments'
import { useScrollIntoView } from './use-scroll-into-view'

/** the best moments that are not in the highlight video, in one list, best first */
export function SuggestionList({
  project,
  moments,
  activeId,
  isPending,
  timesOf,
  onActivate,
  onAdd
}: {
  project: Project
  moments: Moment[]
  activeId: MomentId | null
  /** main is taking the clip in right now: disabled until it answers */
  isPending: (id: MomentId) => boolean
  timesOf: (moment: Moment) => TimeRange
  onActivate: (id: MomentId) => void
  onAdd: (id: MomentId) => void
}): React.JSX.Element {
  const listRef = useRef<HTMLUListElement>(null)
  useScrollIntoView(listRef, '.suggestion.is-active', [activeId])

  return (
    <ul ref={listRef} className="suggestions__list" aria-label="Suggestions, best first">
      {moments.map((moment) => {
        const videoIndex = project.videos.findIndex((v) => v.id === moment.videoId)
        const times = timesOf(moment)
        const pending = isPending(moment.id)
        return (
          <li
            key={moment.id}
            className={cx(
              'suggestion',
              pending && 'is-pending',
              moment.id === activeId && 'is-active'
            )}
            data-testid="suggestion-item"
            data-moment-id={moment.id}
            aria-busy={pending || undefined}
          >
            <button
              type="button"
              className="suggestion__main"
              onClick={() => onActivate(moment.id)}
              aria-current={moment.id === activeId ? 'true' : undefined}
            >
              <Frame
                video={project.videos[videoIndex]}
                time={times.start + 0.5}
                width={40}
                height={52}
              />
              <span className="suggestion__info">
                <span className="suggestion__title">{moment.title}</span>
                <span className="suggestion__meta num">
                  <span className="suggestion__score" title="Matches your prompt (1–10)">
                    <Star size={10} fill="currentColor" /> {moment.score}
                  </span>
                  Video {videoIndex + 1} · {tc(times.start)}–{tc(times.end)} ·{' '}
                  {formatSeconds(times.end - times.start)}
                </span>
              </span>
            </button>
            <IconButton
              icon={Plus}
              size="sm"
              variant="accent"
              label="Add to the highlight video (X)"
              disabled={pending}
              onClick={(event) => {
                if (!isRepeatClick(event)) onAdd(moment.id)
              }}
              data-testid="clip-toggle"
            />
          </li>
        )
      })}
    </ul>
  )
}
