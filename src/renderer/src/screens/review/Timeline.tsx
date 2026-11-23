import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react'
import { ZoomIn, ZoomOut } from 'lucide-react'
import type { VideoInfo } from '@shared/types'
import { IconButton } from '../../components/ui/Button'
import { cx } from '../../lib/dom'
import { tc } from '../../lib/format'
import { imageSrc, spriteTileIndex, spriteTileWidth } from '../../lib/media'
import { dragEdge, editPoint, zoomWindow, type TimeRange, type TrimRoom } from '../../lib/moments'
import { usePlayback, type PlaybackController } from './playback'

const STRIP_HEIGHT = 56
const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
/** a press on a handle that moves less is a click, not a drag: jitter does not move the edge */
const CLICK_SLOP_PX = 3

type Edge = 'start' | 'end'

interface DragState {
  edge: Edge
  origin: TimeRange
  /** the visible window stays put while a handle moves */
  view: TimeRange
  wasPlaying: boolean
  /** pointer x at the press, and its distance in px to the edge (the edge keeps it while dragging) */
  pressX: number
  grabPx: number
}

const edgeOf = (element: HTMLElement): Edge => (element.dataset.edge === 'end' ? 'end' : 'start')

function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    setWidth(element.clientWidth)
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width
}

function Playhead({
  controller,
  videoId,
  view,
  width,
  className
}: {
  controller: PlaybackController
  videoId: string
  view: TimeRange
  width: number
  className: string
}): React.JSX.Element | null {
  const time = usePlayback(controller, (s) => s.time)
  const current = usePlayback(controller, (s) => s.videoId)
  if (current !== videoId || time < view.start || time > view.end || width === 0) return null
  const x = ((time - view.start) / (view.end - view.start)) * width
  return <span className={className} style={{ transform: `translateX(${x}px)` }} aria-hidden />
}

export interface TimelineProps {
  video: VideoInfo
  controller: PlaybackController
  /** the editable clip */
  range: TimeRange
  /** how far the edges may go: the video, and the neighbours in the highlight video */
  room: TrimRoom
  /** other moments of the same video, drawn as faint markers */
  others: TimeRange[]
  minLength: number
  /**
   * draft while dragging (final = false), commit on release (final = true) if the range changed;
   * a drag back to where it began ends with that range as a draft, a mere click sends nothing
   */
  onRangeChange: (range: TimeRange, final: boolean) => void
  /** called before any seek or trim starts here (e.g. to end a running preview first) */
  onInteract: () => void
}

export function Timeline({
  video,
  controller,
  range,
  room,
  others,
  minLength,
  onRangeChange,
  onInteract
}: TimelineProps): React.JSX.Element {
  const stripRef = useRef<HTMLDivElement>(null)
  const overviewRef = useRef<HTMLDivElement>(null)
  const width = useWidth(stripRef)
  const overviewWidth = useWidth(overviewRef)
  // starts zoomed to the clip's surroundings
  const [zoom, setZoom] = useState(true)
  const [drag, setDrag] = useState<DragState | null>(null)
  // a ref, not state: a release in the same frame as the first move must still see it
  const moved = useRef(false)
  const duration = video.durationSec
  const full: TimeRange = { start: 0, end: duration }
  // the window follows the clip, except while a handle is being dragged
  const view = drag ? drag.view : zoom ? zoomWindow(range, duration) : full

  const span = Math.max(0.001, view.end - view.start)
  const toX = (t: number): number => ((t - view.start) / span) * width
  const timeAt = (clientX: number): number => {
    const rect = stripRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return view.start
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return view.start + ratio * span
  }

  // filmstrip tiles
  const info = video.spriteInfo
  const sprite = imageSrc(video.spritePath)
  const tileWidth = info ? spriteTileWidth(info, STRIP_HEIGHT) : 0
  const tiles: { x: number; index: number }[] = []
  if (info && sprite && width > 0) {
    for (let x = 0; x < width; x += tileWidth) {
      const t = view.start + ((x + tileWidth / 2) / width) * span
      tiles.push({ x, index: spriteTileIndex(info, t) })
    }
  }

  const tickStep =
    TICK_STEPS.find((step) => (step / span) * width >= 70) ?? TICK_STEPS[TICK_STEPS.length - 1]
  const ticks: number[] = []
  for (let t = Math.ceil(view.start / tickStep) * tickStep; t <= view.end + 1e-6; t += tickStep) {
    ticks.push(t)
  }

  const startHandleDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    // preventDefault keeps the press from focusing the handle; its ←/→ should work after a click
    event.currentTarget.focus({ preventScroll: true })
    onInteract()
    const edge = edgeOf(event.currentTarget)
    const wasPlaying = controller.getState().playing
    controller.pause()
    const at = edge === 'start' ? range.start : range.end
    const rect = stripRef.current?.getBoundingClientRect()
    // in px, not s: timeAt clamps to the strip, and a handle at the view's edge lies outside it
    const grabPx = rect ? event.clientX - rect.left - ((at - view.start) / span) * rect.width : 0
    moved.current = false
    setDrag({ edge, origin: range, view, wasPlaying, pressX: event.clientX, grabPx })
    controller.seek(at)
  }

  const moveHandle = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!drag) return
    if (!moved.current && Math.abs(event.clientX - drag.pressX) < CLICK_SLOP_PX) return
    moved.current = true
    const t = timeAt(event.clientX - drag.grabPx)
    const next = dragEdge(drag.origin, drag.edge, t, room, minLength)
    onRangeChange(next, false)
    controller.seek(drag.edge === 'start' ? next.start : Math.max(next.start, next.end - 0.05))
  }

  const endHandleDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!drag) return
    const released = event.type === 'pointerup'
    const dragged =
      moved.current || (released && Math.abs(event.clientX - drag.pressX) >= CLICK_SLOP_PX)
    setDrag(null)
    let next = drag.origin
    if (dragged) {
      next = released
        ? dragEdge(drag.origin, drag.edge, timeAt(event.clientX - drag.grabPx), room, minLength)
        : range
      // only a change is committed; a drag that ends where it began just takes its draft back
      onRangeChange(next, next.start !== drag.origin.start || next.end !== drag.origin.end)
    }
    controller.updateLoop(next)
    controller.seek(editPoint(next, drag.edge))
    if (drag.wasPlaying) controller.play()
  }

  const handleKey = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const step = event.shiftKey ? 1 : 0.1
    const delta = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
    if (!delta) return
    event.preventDefault()
    event.stopPropagation()
    onInteract()
    const edge = edgeOf(event.currentTarget)
    const value = (edge === 'start' ? range.start : range.end) + delta
    const next = dragEdge(range, edge, value, room, minLength)
    onRangeChange(next, true)
    controller.updateLoop(next)
    controller.seek(editPoint(next, edge))
  }

  const scrub = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    onInteract()
    controller.seek(timeAt(event.clientX))
  }

  const overviewSeek = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    controller.seek(ratio * duration)
  }

  const pct = (t: number): string => `${(t / duration) * 100}%`
  const clipLeft = toX(range.start)
  const clipWidth = Math.max(2, toX(range.end) - clipLeft)

  return (
    <div className={cx('timeline', drag && 'is-dragging')}>
      <div className="timeline__overview-row">
        <div
          ref={overviewRef}
          className="timeline__overview"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
            onInteract()
            overviewSeek(event)
          }}
          onPointerMove={(event) => {
            if (event.buttons === 1) overviewSeek(event)
          }}
          title="Whole video: click to jump"
        >
          {others.map((other, i) => (
            <span
              key={i}
              className="timeline__ov-mark"
              style={{ left: pct(other.start), width: pct(other.end - other.start) }}
            />
          ))}
          {zoom && (
            <span
              className="timeline__ov-window"
              style={{ left: pct(view.start), width: pct(view.end - view.start) }}
            />
          )}
          <span
            className="timeline__ov-clip"
            style={{ left: pct(range.start), width: pct(range.end - range.start) }}
          />
          <Playhead
            controller={controller}
            videoId={video.id}
            view={full}
            width={overviewWidth}
            className="timeline__ov-playhead"
          />
        </div>
        <IconButton
          icon={zoom ? ZoomOut : ZoomIn}
          size="sm"
          label={zoom ? 'Show whole video' : 'Zoom in on the clip'}
          onClick={() => setZoom(!zoom)}
          data-testid="timeline-zoom"
        />
      </div>

      <div
        ref={stripRef}
        className="timeline__strip"
        onPointerDown={scrub}
        onPointerMove={(event) => {
          if (event.buttons === 1 && !drag) controller.seek(timeAt(event.clientX))
        }}
        data-testid="timeline"
      >
        <div className="timeline__tiles" aria-hidden>
          {tiles.length > 0 && info && sprite
            ? tiles.map((tile) => (
                <span
                  key={tile.x}
                  className="timeline__tile"
                  style={{
                    left: tile.x,
                    width: tileWidth,
                    backgroundImage: `url("${sprite}")`,
                    backgroundSize: `${info.columns * tileWidth}px ${STRIP_HEIGHT}px`,
                    backgroundPosition: `${-tile.index * tileWidth}px 0`
                  }}
                />
              ))
            : !info && <span className="timeline__no-sprite">Creating filmstrip…</span>}
        </div>
        {others
          .filter((other) => other.end > view.start && other.start < view.end)
          .map((other, i) => (
            <span
              key={i}
              className="timeline__marker"
              style={{
                left: toX(other.start),
                width: Math.max(2, toX(other.end) - toX(other.start))
              }}
            />
          ))}
        <span className="timeline__shade" style={{ left: 0, width: Math.max(0, clipLeft) }} />
        <span className="timeline__shade" style={{ left: clipLeft + clipWidth, right: 0 }} />
        <div className="timeline__clip" style={{ left: clipLeft, width: clipWidth }}>
          <span
            className="timeline__handle timeline__handle--start"
            role="slider"
            tabIndex={0}
            aria-label="Clip start"
            title="Drag the start, or click it and move it with ← → (0.1 s, with ⇧ 1 s)"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={range.start}
            aria-valuetext={tc(range.start, 1)}
            data-edge="start"
            onPointerDown={startHandleDrag}
            onPointerMove={moveHandle}
            onPointerUp={endHandleDrag}
            onPointerCancel={endHandleDrag}
            onKeyDown={handleKey}
            data-testid="handle-in"
          />
          <span
            className="timeline__handle timeline__handle--end"
            role="slider"
            tabIndex={0}
            aria-label="Clip end"
            title="Drag the end, or click it and move it with ← → (0.1 s, with ⇧ 1 s)"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={range.end}
            aria-valuetext={tc(range.end, 1)}
            data-edge="end"
            onPointerDown={startHandleDrag}
            onPointerMove={moveHandle}
            onPointerUp={endHandleDrag}
            onPointerCancel={endHandleDrag}
            onKeyDown={handleKey}
            data-testid="handle-out"
          />
        </div>
        {drag && (
          <span
            className="timeline__drag-time num"
            style={{ left: drag.edge === 'start' ? clipLeft : clipLeft + clipWidth }}
          >
            {tc(drag.edge === 'start' ? range.start : range.end, 1)}
          </span>
        )}
        <Playhead
          controller={controller}
          videoId={video.id}
          view={view}
          width={width}
          className="timeline__playhead"
        />
      </div>

      <div className="timeline__ruler" aria-hidden>
        {width > 0 &&
          ticks.map((t) => (
            <span key={t} className="timeline__tick num" style={{ left: toX(t) }}>
              {tc(t)}
            </span>
          ))}
      </div>
    </div>
  )
}
