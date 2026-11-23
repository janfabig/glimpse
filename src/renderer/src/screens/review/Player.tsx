import { useEffect, useMemo, useRef } from 'react'
import { CircleAlert, Pause, Play, Square } from 'lucide-react'
import type { VideoInfo } from '@shared/types'
import { tc } from '../../lib/format'
import { videoSource, type FrameDrawer } from '../../lib/media'
import { usePlayback, type PlaybackController, type PlaybackSurface } from './playback'

/** <video> backed surface (proxy via hc-media:) */
function HtmlVideo({
  url,
  videoId,
  controller
}: {
  url: string
  videoId: string
  controller: PlaybackController
}): React.JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const surface: PlaybackSurface = {
      get currentTime() {
        return element.currentTime
      },
      seek: (t) => {
        element.currentTime = Math.min(t, Number.isFinite(element.duration) ? element.duration : t)
      },
      play: () => void element.play().catch(() => undefined),
      pause: () => element.pause()
    }
    const listeners: [keyof HTMLMediaElementEventMap, () => void][] = [
      ['loadedmetadata', () => controller.attach(surface, videoId)],
      ['play', () => controller.handlePlay(surface)],
      ['pause', () => controller.handlePause(surface)],
      ['seeked', () => controller.handleSeeked(surface)],
      ['ended', () => controller.handleEnded(surface)],
      ['error', () => controller.handleError('This video cannot be played.')]
    ]
    for (const [type, listener] of listeners) element.addEventListener(type, listener)
    if (element.readyState >= 1) controller.attach(surface, videoId)
    return () => {
      for (const [type, listener] of listeners) element.removeEventListener(type, listener)
      controller.detach(surface)
      element.pause()
    }
  }, [url, videoId, controller])

  return <video ref={ref} className="player__media" src={url} preload="auto" playsInline />
}

/** canvas surface for the mock API: draws generated frames on a virtual clock */
function SyntheticVideo({
  draw,
  video,
  controller
}: {
  draw: FrameDrawer
  video: VideoInfo
  controller: PlaybackController
}): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const portrait = video.height >= video.width
  const width = portrait ? 720 : 1280
  const height = portrait ? 960 : 720

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const duration = video.durationSec
    let base = 0
    let startedAt = 0
    let playing = false
    let frame = 0
    const now = (): number => performance.now() / 1000
    const current = (): number => (playing ? Math.min(duration, base + now() - startedAt) : base)
    const paint = (): void => draw(ctx, canvas.width, canvas.height, current())
    const surface: PlaybackSurface = {
      get currentTime() {
        return current()
      },
      seek: (t) => {
        base = Math.min(duration, Math.max(0, t))
        startedAt = now()
        paint()
        controller.handleSeeked(surface)
      },
      play: () => {
        if (playing) return
        if (base >= duration) base = 0
        startedAt = now()
        playing = true
        frame = requestAnimationFrame(loop)
        controller.handlePlay(surface)
      },
      pause: () => {
        if (!playing) return
        base = current()
        playing = false
        cancelAnimationFrame(frame)
        paint()
        controller.handlePause(surface)
      }
    }
    const loop = (): void => {
      if (!playing) return
      if (current() >= duration) {
        base = duration
        playing = false
        paint()
        controller.handlePause(surface)
        controller.handleEnded(surface)
        return
      }
      paint()
      frame = requestAnimationFrame(loop)
    }
    paint()
    controller.attach(surface, video.id)
    return () => {
      playing = false
      cancelAnimationFrame(frame)
      controller.detach(surface)
    }
  }, [draw, video.id, video.durationSec, controller])

  return <canvas ref={ref} className="player__canvas" width={width} height={height} />
}

/** shades the part of the picture that the export crops away */
function CropShade({
  video,
  crop
}: {
  video: VideoInfo
  crop: { width: number; height: number }
}): React.JSX.Element {
  const { width: w, height: h } = video
  const x = (w * (1 - crop.width)) / 2
  const y = (h * (1 - crop.height)) / 2
  return (
    // the viewBox has the video's shape, so its default "meet" scaling matches object-fit: contain
    <svg className="player__crop" viewBox={`0 0 ${w} ${h}`} aria-hidden>
      {/* even-odd: the whole picture minus the centred window the export keeps */}
      <path fillRule="evenodd" d={`M0 0H${w}V${h}H0Z M${x} ${y}H${w - x}V${h - y}H${x}Z`} />
    </svg>
  )
}

export function Player({
  controller,
  videos,
  cropOf
}: {
  controller: PlaybackController
  videos: VideoInfo[]
  /** part of the picture the export keeps (fractions); the rest is shaded */
  cropOf: (video: VideoInfo) => { width: number; height: number } | null
}): React.JSX.Element {
  const videoId = usePlayback(controller, (s) => s.videoId)
  const playing = usePlayback(controller, (s) => s.playing)
  const error = usePlayback(controller, (s) => s.error)
  const sequence = usePlayback(controller, (s) => s.sequence)
  const video = videos.find((v) => v.id === videoId) ?? null
  const sourceKey = video ? `${video.id}|${video.proxyPath}|${video.posterPath}` : ''
  // the source only changes with the video or its proxy
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const source = useMemo(() => (video ? videoSource(video) : null), [sourceKey])
  const crop = video && cropOf(video)

  return (
    <div className="player" data-testid="player">
      {video && source?.kind === 'url' && (
        <HtmlVideo key={source.url} url={source.url} videoId={video.id} controller={controller} />
      )}
      {video && source?.kind === 'synthetic' && (
        <SyntheticVideo key={source.key} draw={source.draw} video={video} controller={controller} />
      )}
      {video && crop && <CropShade video={video} crop={crop} />}
      {!video && <p className="player__empty">Choose a clip on the left.</p>}
      {error && (
        <p className="player__error">
          <CircleAlert size={16} /> {error}
        </p>
      )}
      {video && !error && (
        <button
          type="button"
          className={playing ? 'player__hit is-playing' : 'player__hit'}
          onClick={() => controller.toggle()}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          <span className="player__big-button" aria-hidden>
            {playing ? (
              <Pause size={26} fill="currentColor" />
            ) : (
              <Play size={26} fill="currentColor" />
            )}
          </span>
        </button>
      )}
      {sequence && (
        <div className="player__sequence">
          <span className="badge badge--solid">
            Preview · clip {sequence.index + 1} of {sequence.items.length}
          </span>
          <button type="button" className="player__stop" onClick={() => controller.stopSequence()}>
            <Square size={12} fill="currentColor" /> Stop
          </button>
        </div>
      )}
    </div>
  )
}

/** play/pause + time readout under the player */
export function TransportBar({
  controller,
  durationSec
}: {
  controller: PlaybackController
  durationSec: number
}): React.JSX.Element {
  const playing = usePlayback(controller, (s) => s.playing)
  const time = usePlayback(controller, (s) => s.time)
  return (
    <div className="transport">
      <button
        type="button"
        className="transport__play"
        onClick={() => controller.toggle()}
        aria-label={playing ? 'Pause (Space)' : 'Play (Space)'}
        title={playing ? 'Pause (Space)' : 'Play (Space)'}
        data-testid="play-toggle"
      >
        {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
      </button>
      <span className="transport__time num">
        {tc(time, 1)} <span className="faint">/ {tc(durationSec)}</span>
      </span>
    </div>
  )
}
