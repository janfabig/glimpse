// Playback state for the review player: which video is shown, loop of the active clip and the
// sequential preview of all selected clips. Framework-free; React subscribes via usePlayback().

import { useSyncExternalStore } from 'react'
import type { MomentId, VideoId } from '@shared/types'
import type { TimeRange } from '../../lib/moments'

/** what the controller needs from a <video> element (or the mock's canvas player) */
export interface PlaybackSurface {
  readonly currentTime: number
  seek(t: number): void
  play(): void
  pause(): void
}

export interface Segment extends TimeRange {
  momentId: MomentId
  videoId: VideoId
}

export interface PlaybackState {
  videoId: VideoId | null
  time: number
  playing: boolean
  /** range of the active clip; playback wraps around inside it */
  loop: TimeRange | null
  sequence: { items: Segment[]; index: number } | null
  error: string | null
}

const END_EPSILON = 0.04

export class PlaybackController {
  private state: PlaybackState = {
    videoId: null,
    time: 0,
    playing: false,
    loop: null,
    sequence: null,
    error: null
  }
  private readonly listeners = new Set<() => void>()
  private surface: PlaybackSurface | null = null
  /** seek/play requested before the surface for the new video was ready */
  private pending: { time: number; play: boolean } | null = null
  /** false after the user moved the playhead outside the loop range */
  private loopEngaged = true
  private frame = 0
  private resume: { videoId: VideoId; loop: TimeRange | null; time: number } | null = null

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getState = (): PlaybackState => this.state

  private patch(next: Partial<PlaybackState>): void {
    this.state = { ...this.state, ...next }
    this.listeners.forEach((listener) => listener())
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /** shows a clip and loops it */
  showClip(videoId: VideoId, range: TimeRange, autoplay: boolean): void {
    this.endSequence()
    this.loopEngaged = true
    this.patch({ loop: range })
    this.load(videoId, range.start, autoplay)
  }

  /**
   * the active clip was trimmed: keep playing, wrap inside the new range. An edit calls this before
   * it seeks into the new range (e.g. to an earlier start), so that seek does not leave the loop.
   */
  updateLoop(range: TimeRange | null): void {
    this.patch({ loop: range })
  }

  play(): void {
    const surface = this.surface
    if (!surface) {
      if (this.pending) this.pending.play = true
      return
    }
    const { loop, sequence } = this.state
    if (!sequence && loop && this.loopEngaged) {
      const t = surface.currentTime
      if (t >= loop.end - END_EPSILON || t < loop.start - 0.05) surface.seek(loop.start)
    }
    surface.play()
  }

  pause(): void {
    if (this.pending) this.pending.play = false
    this.surface?.pause()
  }

  toggle(): void {
    if (this.state.playing) this.pause()
    else this.play()
  }

  /** user seek; moving the playhead outside the clip releases the loop until the next showClip */
  seek(t: number): void {
    const time = Math.max(0, t)
    const { loop } = this.state
    this.loopEngaged = !loop || (time >= loop.start - 0.01 && time < loop.end - END_EPSILON)
    if (this.surface) this.surface.seek(time)
    else if (this.pending) this.pending.time = time
    this.patch({ time })
  }

  /** plays the given clips back to back from `start`, then returns to the previously shown clip */
  playSequence(items: Segment[], start = 0): void {
    const first = items[start]
    if (!first) return
    const { videoId, loop, time } = this.state
    this.resume = videoId ? { videoId, loop, time } : null
    this.patch({ sequence: { items, index: start } })
    this.load(first.videoId, first.start, true)
  }

  stopSequence(): void {
    if (!this.state.sequence) return
    this.pause()
    const resume = this.resume
    this.endSequence()
    if (resume) {
      this.loopEngaged = true
      this.patch({ loop: resume.loop })
      this.load(resume.videoId, resume.loop?.start ?? resume.time, false)
    }
  }

  /**
   * Ends the preview but stays on the clip that is playing: it keeps its position and loops from
   * now on (used when the user starts editing during the preview). Returns that clip.
   */
  stopSequenceHere(): Segment | null {
    const sequence = this.state.sequence
    if (!sequence) return null
    const item = sequence.items[sequence.index]
    this.resume = null
    this.loopEngaged = true
    this.patch({ sequence: null, loop: { start: item.start, end: item.end } })
    return item
  }

  dispose(): void {
    this.stopTicking()
    this.surface?.pause()
    this.surface = null
    this.listeners.clear()
  }

  // ---------------------------------------------------------------------------
  // Surface wiring (called by the player components)
  // ---------------------------------------------------------------------------

  attach(surface: PlaybackSurface, videoId: VideoId): void {
    if (videoId !== this.state.videoId) return
    this.surface = surface
    const pending = this.pending
    this.pending = null
    if (pending) {
      surface.seek(pending.time)
      if (pending.play) surface.play()
    }
    this.patch({ error: null })
  }

  /**
   * The surface goes away (e.g. the proxy replaced the original file): remember position and
   * play state, so the next surface for the same video continues where this one stopped.
   */
  detach(surface: PlaybackSurface): void {
    if (this.surface !== surface) return
    this.surface = null
    this.stopTicking()
    this.pending ??= { time: this.state.time, play: this.state.playing }
    if (this.state.playing) this.patch({ playing: false })
  }

  handlePlay(surface: PlaybackSurface): void {
    if (surface !== this.surface) return
    this.patch({ playing: true })
    this.startTicking()
  }

  handlePause(surface: PlaybackSurface): void {
    if (surface !== this.surface) return
    this.stopTicking()
    this.patch({ playing: false, time: surface.currentTime })
  }

  handleSeeked(surface: PlaybackSurface): void {
    if (surface === this.surface && !this.state.playing) this.patch({ time: surface.currentTime })
  }

  handleEnded(surface: PlaybackSurface): void {
    if (surface !== this.surface) return
    if (this.state.sequence) {
      this.advance()
      return
    }
    const { loop } = this.state
    if (loop && this.loopEngaged) {
      surface.seek(loop.start)
      surface.play()
    }
  }

  handleError(message: string): void {
    this.stopTicking()
    this.patch({ error: message, playing: false })
  }

  // ---------------------------------------------------------------------------

  private load(videoId: VideoId, time: number, play: boolean): void {
    if (this.state.videoId === videoId && this.surface) {
      this.surface.seek(time)
      if (play) this.surface.play()
      this.patch({ time })
      return
    }
    // a failed element stays mounted for the same video and never loads again: keep its error
    const error = this.state.videoId === videoId ? this.state.error : null
    this.surface?.pause()
    this.surface = null
    this.stopTicking()
    this.pending = { time, play }
    this.patch({ videoId, time, playing: false, error })
  }

  private endSequence(): void {
    this.resume = null
    if (this.state.sequence) this.patch({ sequence: null })
  }

  private advance(): void {
    const sequence = this.state.sequence
    if (!sequence) return
    const index = sequence.index + 1
    if (index >= sequence.items.length) {
      this.stopSequence()
      return
    }
    const next = sequence.items[index]
    this.patch({ sequence: { ...sequence, index } })
    this.load(next.videoId, next.start, true)
  }

  private readonly tick = (): void => {
    this.frame = 0
    const surface = this.surface
    if (!surface) return
    const t = surface.currentTime
    const { sequence, loop } = this.state
    if (sequence) {
      if (t >= sequence.items[sequence.index].end - END_EPSILON) this.advance()
    } else if (loop && this.loopEngaged && t >= loop.end - END_EPSILON) {
      surface.seek(loop.start)
    }
    // the next clip may play on another surface, which reports its own time
    if (this.surface !== surface) return
    const now = surface.currentTime
    if (now !== this.state.time) this.patch({ time: now })
    if (this.state.playing) this.frame = requestAnimationFrame(this.tick)
  }

  private startTicking(): void {
    if (!this.frame) this.frame = requestAnimationFrame(this.tick)
  }

  private stopTicking(): void {
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
  }
}

/** subscribes a component to one slice of the playback state (return primitives or stable refs) */
export function usePlayback<T>(
  controller: PlaybackController,
  select: (state: PlaybackState) => T
): T {
  return useSyncExternalStore(controller.subscribe, () => select(controller.getState()))
}
