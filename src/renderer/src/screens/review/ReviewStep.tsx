import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Clapperboard, Play, Sparkles, Square, WandSparkles } from 'lucide-react'
import { LIMITS } from '@shared/presets'
import { formatDurationDe } from '@shared/time'
import type { Moment, MomentId, Project } from '@shared/types'
import { trimBounds } from '../../../../main/core/selection'
import { StepFooter } from '../../components/StepLayout'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { isAnalysisRunning, reelKeptAfterRun } from '../../lib/analysis'
import { cx } from '../../lib/dom'
import { cropWindow } from '../../lib/export'
import { plural } from '../../lib/format'
import {
  dragEdge,
  editPoint,
  effectiveLength,
  lengthStatus,
  suggestions,
  withInPoint,
  withOutPoint,
  type TrimRoom
} from '../../lib/moments'
import {
  autoSelect,
  goToStep,
  mutate,
  rememberReviewFocus,
  removeFromReel,
  setMomentSelected,
  toast
} from '../../store/actions'
import { itemKey, useApp } from '../../store/app-store'
import { ClipDetails } from './ClipDetails'
import { AgainButton } from './AgainDialog'
import { ClipList } from './ClipList'
import { LengthMeter } from './LengthMeter'
import { PlaybackController, usePlayback } from './playback'
import { Player, TransportBar } from './Player'
import { ShortcutHints } from './ShortcutHints'
import { SuggestionList } from './SuggestionList'
import { Timeline } from './Timeline'
import { TrimControls } from './TrimControls'
import { useShortcuts } from './use-shortcuts'
import { useTimeOverrides } from './use-time-overrides'
import './review.css'

export function ReviewStep({ project }: { project: Project }): React.JSX.Element {
  // "Ask Gemini again" is a dialog like the others: the shortcuts rest while it is open
  const [again, setAgain] = useState(false)
  const dialogOpen = useApp((s) => s.settingsOpen || s.confirm !== null) || again
  // clips main is changing right now (taken in or out): disabled until it answers
  const pending = useApp((s) => s.pending)
  const isPending = (id: MomentId): boolean => !!pending[itemKey.moment(id)]
  const controller = useMemo(() => new PlaybackController(), [])
  useEffect(() => () => controller.dispose(), [controller])
  const { timesOf, commit, preview } = useTimeOverrides()

  const moments = project.moments
  const selected = useMemo(() => moments.filter((m) => m.selected), [moments])
  const videos = useMemo(
    () => new Map(project.videos.map((video, index) => [video.id, { video, index }])),
    [project.videos]
  )
  const analysing = isAnalysisRunning(project)

  // back from another step: the clip and tab the user left (read once, on mount), unless it is gone
  const [remembered] = useState(() => {
    const focus = useApp.getState().reviewFocus[project.id]
    return focus && moments.some((m) => m.id === focus.momentId) ? focus : undefined
  })
  const [tab, setTab] = useState(remembered?.tab ?? 'clips')
  // pinned from the start, so X on the active clip toggles that clip and not its neighbour
  const [chosenId, setChosenId] = useState<MomentId | null>(
    () => remembered?.momentId ?? selected[0]?.id ?? moments[0]?.id ?? null
  )
  const autoplay = useRef(false)
  /** clip taken over from the running preview – it is already loaded, so it must not restart */
  const adopted = useRef<MomentId | null>(null)
  /** clip that X, + or ✕ just moved to the other list: ↑/↓ start from its place on this tab */
  const moved = useRef<MomentId | null>(null)
  useEffect(() => {
    moved.current = null
  }, [tab])

  // the chosen clip – or a sensible fallback once it is gone (replaced by a new analysis)
  const active = moments.find((m) => m.id === chosenId) ?? selected[0] ?? moments[0] ?? null
  const activeId = active?.id ?? null
  const activeTimes = active ? timesOf(active) : null
  const sequence = usePlayback(controller, (s) => s.sequence)
  const previewingId = sequence ? sequence.items[sequence.index].momentId : null
  // during "Play preview" the editor follows the clip that is playing
  const shown = (previewingId && moments.find((m) => m.id === previewingId)) || active
  const shownEntry = shown ? videos.get(shown.videoId) : undefined
  const shownTimes = shown ? timesOf(shown) : null
  const suggestionSlots = suggestions(project, shown?.id)
  const suggestionRows = suggestionSlots.filter((m) => !m.selected)
  // the preview plays the highlight video as it was when it started: it ends once a clip comes,
  // goes or moves (row ✕ and chevrons, +, “Undo”, “Auto-select”, a finished analysis)
  const reelOrder = selected.map((m) => m.id).join()
  useEffect(() => controller.stopSequence(), [reelOrder, controller])
  // one clip early, so the preview plays both cuts around the active clip
  const previewStart = Math.max(0, selected.findIndex((m) => m.id === activeId) - 1)

  useEffect(() => {
    if (activeId) rememberReviewFocus(project.id, { momentId: activeId, tab })
  }, [project.id, activeId, tab])

  // load the active clip into the player whenever another clip becomes active
  useEffect(() => {
    if (!active || !activeTimes) return
    const keep = adopted.current === active.id
    adopted.current = null
    if (!keep) controller.showClip(active.videoId, activeTimes, autoplay.current)
    autoplay.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, controller])

  // trims of the active clip move the loop
  useEffect(() => {
    if (activeTimes && !controller.getState().sequence) controller.updateLoop(activeTimes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTimes?.start, activeTimes?.end, controller])

  const activate = (id: MomentId, play = true): void => {
    const moment = moments.find((m) => m.id === id)
    if (!moment) return
    if (id === activeId) {
      controller.showClip(moment.videoId, timesOf(moment), play)
      return
    }
    // ends a running preview without loading the previous clip first; the effect loads this one
    controller.stopSequenceHere()
    autoplay.current = play
    setChosenId(id)
  }

  /**
   * Every edit goes through here: during the preview it takes over the clip that is playing
   * (the preview ends, the clip keeps its position and becomes the active one).
   */
  const beginEdit = (): Moment | null => {
    const item = controller.stopSequenceHere()
    if (!item) return active
    const moment = moments.find((m) => m.id === item.momentId) ?? null
    if (moment && moment.id !== activeId) {
      adopted.current = moment.id
      setChosenId(moment.id)
    }
    return moment
  }

  const setSelected = (id: MomentId, value: boolean): void => {
    moved.current = id
    void setMomentSelected(id, value)
  }

  const minLength = LIMITS.minMomentSec
  const durationOf = (moment: Moment): number => videos.get(moment.videoId)?.video.durationSec ?? 0
  /** main's limits of a trim, on the times as shown: commits that are still under way count */
  const roomOf = (moment: Moment): TrimRoom =>
    trimBounds(
      { ...moment, ...timesOf(moment) },
      moments.map((m) => ({ ...m, ...timesOf(m) })),
      durationOf(moment)
    )
  const playheadOn = (moment: Moment | null): number | null => {
    const state = controller.getState()
    return moment && state.videoId === moment.videoId ? state.time : null
  }

  const setEdge = (edge: 'start' | 'end'): void => {
    const moment = beginEdit()
    const t = playheadOn(moment)
    if (!moment || t === null) return
    const set = edge === 'start' ? withInPoint : withOutPoint
    void commit(moment.id, set(timesOf(moment), t, roomOf(moment), minLength))
  }

  const nudge = (edge: 'start' | 'end', delta: number): void => {
    const moment = beginEdit()
    if (!moment) return
    const range = timesOf(moment)
    const next = dragEdge(range, edge, range[edge] + delta, roomOf(moment), minLength)
    void commit(moment.id, next)
    controller.updateLoop(next)
    controller.seek(editPoint(next, edge))
  }

  const resetTimes = (): void => {
    const moment = beginEdit()
    if (moment) void mutate({ type: 'resetMomentTimes', momentId: moment.id })
  }

  const toggleShown = (): void => {
    const moment = beginEdit()
    if (moment) setSelected(moment.id, !moment.selected)
  }

  const seekBy = (delta: number): void => {
    const moment = beginEdit()
    if (!moment) return
    const { time } = controller.getState()
    controller.seek(Math.min(durationOf(moment), Math.max(0, time + delta)))
  }

  const step = (direction: 1 | -1): void => {
    // walks the rows of the open tab. The shown clip keeps its place among them when it was just
    // moved to the other list; when it never was one of them, the keys start at the top row
    const slotId = shown && moved.current === shown.id ? shown.id : null
    const list =
      tab === 'clips'
        ? moments.filter((m) => m.selected || m.id === slotId)
        : suggestionSlots.filter((m) => !m.selected || m.id === slotId)
    const index = shown ? list.findIndex((m) => m.id === shown.id) : -1
    const next = list[index + direction] ?? (index < 0 ? list[0] : undefined)
    if (next) activate(next.id, controller.getState().playing)
  }

  useShortcuts(
    {
      ' ': () => controller.toggle(),
      ArrowUp: () => step(-1),
      ArrowDown: () => step(1),
      i: () => setEdge('start'),
      o: () => setEdge('end'),
      x: toggleShown,
      ArrowLeft: () => seekBy(-1),
      ArrowRight: () => seekBy(1),
      // unshifted on German keyboards; = is + without ⇧ on US ones
      ',': () => nudge('start', -0.5),
      '.': () => nudge('start', 0.5),
      '-': () => nudge('end', -0.5),
      '+': () => nudge('end', 0.5),
      '=': () => nudge('end', 0.5)
    },
    !dialogOpen
  )

  const togglePreview = (): void => {
    if (sequence) {
      controller.stopSequence()
      return
    }
    controller.playSequence(
      selected.map((m) => ({ momentId: m.id, videoId: m.videoId, ...timesOf(m) })),
      previewStart
    )
  }

  const runAutoSelect = async (): Promise<void> => {
    const result = await autoSelect()
    if (!result) return
    const chosen = result.moments.filter((m) => m.selected)
    const length = effectiveLength(chosen, result.exportSettings)
    toast(
      'success',
      `Auto-selected: ${plural(chosen.length, 'clip', 'clips')} · ${formatDurationDe(length)}`
    )
    setTab('clips')
  }

  const status = lengthStatus(
    effectiveLength(selected.map(timesOf), project.exportSettings),
    project.brief.targetDurationSec
  )
  const canReset =
    !!shown &&
    shown.aiStart !== undefined &&
    shown.aiEnd !== undefined &&
    !!shownTimes &&
    (Math.abs(shownTimes.start - shown.aiStart) > 0.005 ||
      Math.abs(shownTimes.end - shown.aiEnd) > 0.005)

  return (
    <main className="step" data-screen="review">
      <header className="review__head">
        <div className="review__head-text">
          <h1 className="h1">Edit</h1>
          <p className="review__subtitle">
            Review the clips, trim them and put them in the right order.
          </p>
        </div>
        <div className="review__tools">
          <LengthMeter status={status} />
          <AgainButton
            project={project}
            open={again}
            onOpenChange={(open) => {
              if (open) controller.pause()
              setAgain(open)
            }}
          />
          <Button
            icon={WandSparkles}
            onClick={() => void runAutoSelect()}
            disabled={moments.length === 0}
            title="Selects the best moments again to match the target length"
            data-testid="auto-select"
          >
            Auto-select
          </Button>
          <Button
            icon={sequence ? Square : Play}
            onClick={togglePreview}
            disabled={selected.length === 0}
            data-testid="preview-all"
          >
            {sequence
              ? 'Stop preview'
              : previewStart > 0
                ? `Preview from clip ${previewStart + 1}`
                : 'Play preview'}
          </Button>
        </div>
      </header>

      {moments.length === 0 ? (
        <div className="step__body">
          <EmptyState
            icon={Clapperboard}
            title="No moments yet"
            actions={
              <Button variant="primary" onClick={() => goToStep('brief')}>
                Change prompt
              </Button>
            }
          >
            Gemini found no matching moments. Change your prompt and analyse again.
          </EmptyState>
        </div>
      ) : (
        <div className="review">
          <aside className="review__side">
            <div className="review__tabs" role="tablist" aria-label="Clips">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'clips'}
                className={cx('review__tab', tab === 'clips' && 'is-active')}
                onClick={() => setTab('clips')}
                data-testid="tab-clips"
              >
                In the highlight video <span className="review__count num">{selected.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'suggestions'}
                className={cx('review__tab', tab === 'suggestions' && 'is-active')}
                onClick={() => setTab('suggestions')}
                data-testid="tab-suggestions"
              >
                More suggestions <span className="review__count num">{suggestionRows.length}</span>
              </button>
            </div>
            <div className="review__list" role="tabpanel">
              {tab === 'clips' ? (
                selected.length > 0 ? (
                  <ClipList
                    clips={selected}
                    videos={videos}
                    activeId={shown?.id ?? null}
                    previewingId={previewingId}
                    isPending={isPending}
                    timesOf={timesOf}
                    onActivate={(id) => activate(id)}
                    onRemove={(id) => {
                      moved.current = id
                      void removeFromReel(id)
                    }}
                    onMove={(id, toIndex) =>
                      void mutate({ type: 'reorderMoment', momentId: id, toIndex })
                    }
                  />
                ) : (
                  <EmptyState icon={Clapperboard} title="No clips in the highlight video yet">
                    Add suggestions with + or click “Auto-select” at the top.
                  </EmptyState>
                )
              ) : suggestionRows.length > 0 ? (
                <SuggestionList
                  project={project}
                  moments={suggestionRows}
                  activeId={shown?.id ?? null}
                  isPending={isPending}
                  timesOf={timesOf}
                  onActivate={(id) => activate(id)}
                  onAdd={(id) => setSelected(id, true)}
                />
              ) : (
                <EmptyState icon={Clapperboard} title="All suggestions are in the highlight video">
                  When you remove a clip with ✕, you will find it here again.
                </EmptyState>
              )}
            </div>
          </aside>

          <section className="review__main">
            <div className="review__stage">
              <Player
                controller={controller}
                videos={project.videos}
                cropOf={(video) =>
                  cropWindow(
                    project.exportSettings,
                    videos.get(selected[0]?.videoId)?.video ?? null,
                    video
                  )
                }
              />
              {shownEntry && (
                <TransportBar controller={controller} durationSec={shownEntry.video.durationSec} />
              )}
            </div>
            {shown && shownEntry && shownTimes && (
              <div className="review__editor">
                <ClipDetails
                  moment={shown}
                  video={shownEntry.video}
                  videoIndex={shownEntry.index}
                  position={
                    shown.selected ? selected.findIndex((m) => m.id === shown.id) + 1 : null
                  }
                  onAdd={() => setSelected(shown.id, true)}
                />
                <TrimControls
                  range={shownTimes}
                  onNudge={nudge}
                  onSetIn={() => setEdge('start')}
                  onSetOut={() => setEdge('end')}
                  onReset={resetTimes}
                  canReset={canReset}
                />
                <Timeline
                  key={shown.id}
                  video={shownEntry.video}
                  controller={controller}
                  range={shownTimes}
                  room={roomOf(shown)}
                  others={moments
                    .filter((m) => m.videoId === shown.videoId && m.id !== shown.id)
                    .map(timesOf)}
                  minLength={minLength}
                  onInteract={() => void beginEdit()}
                  onRangeChange={(range, final) => {
                    // a draft back at the saved times is none (e.g. a drag that ended where it began)
                    const saved = range.start === shown.start && range.end === shown.end
                    if (final) void commit(shown.id, range)
                    else preview(shown.id, saved ? null : range)
                  }}
                />
              </div>
            )}
          </section>
        </div>
      )}

      <StepFooter
        tone={analysing ? 'warning' : 'info'}
        hint={
          analysing ? (
            <>
              <Sparkles size={16} />
              <span>
                {reelKeptAfterRun(project)
                  ? 'Gemini is still analysing. Your selection stays, new moments go to “More suggestions”.'
                  : 'Gemini is still analysing. After that, your highlight video is put together again automatically.'}
              </span>
              <Button size="sm" variant="ghost" onClick={() => goToStep('analysis')}>
                Go to Analysis
              </Button>
            </>
          ) : (
            <ShortcutHints />
          )
        }
      >
        <Button
          variant="primary"
          iconRight={ArrowRight}
          disabled={selected.length === 0}
          onClick={() => goToStep('export')}
          data-testid="go-export"
        >
          Next: Export
        </Button>
      </StepFooter>
    </main>
  )
}
