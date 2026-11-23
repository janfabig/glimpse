import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlaybackController, type PlaybackSurface, type Segment } from './playback'

let frames = new Map<number, FrameRequestCallback>()
let nextFrame = 1

/** runs the pending animation frames once */
function frame(): void {
  const pending = [...frames.values()]
  frames = new Map()
  for (const callback of pending) callback(0)
}

/** stands in for a <video>: time only moves when the test says so */
class FakeSurface implements PlaybackSurface {
  currentTime = 0
  playing = false
  private readonly controller: PlaybackController

  constructor(controller: PlaybackController) {
    this.controller = controller
  }

  seek(t: number): void {
    this.currentTime = t
    this.controller.handleSeeked(this)
  }

  play(): void {
    if (this.playing) return
    this.playing = true
    this.controller.handlePlay(this)
  }

  pause(): void {
    if (!this.playing) return
    this.playing = false
    this.controller.handlePause(this)
  }

  /** playback reached `t`; one animation frame passes */
  advance(t: number): void {
    this.currentTime = t
    frame()
  }
}

const CLIP = { start: 10, end: 14 }

function showing(autoplay = false): { controller: PlaybackController; surface: FakeSurface } {
  const controller = new PlaybackController()
  controller.showClip('v1', CLIP, autoplay)
  const surface = new FakeSurface(controller)
  controller.attach(surface, 'v1')
  return { controller, surface }
}

const segment = (momentId: string, videoId: string, start: number, end: number): Segment => ({
  momentId,
  videoId,
  start,
  end
})

beforeEach(() => {
  frames = new Map()
  nextFrame = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('clip loop', () => {
  it('applies seek and autoplay once the surface for the video is ready', () => {
    const controller = new PlaybackController()
    controller.showClip('v1', CLIP, true)
    expect(controller.getState()).toMatchObject({ videoId: 'v1', time: 10, playing: false })
    const other = new FakeSurface(controller)
    controller.attach(other, 'v2')
    expect(other.playing).toBe(false)
    const surface = new FakeSurface(controller)
    controller.attach(surface, 'v1')
    expect(surface.currentTime).toBe(10)
    expect(controller.getState().playing).toBe(true)
  })

  it('wraps around at the out point and follows trims', () => {
    const { controller, surface } = showing(true)
    surface.advance(12)
    expect(controller.getState().time).toBe(12)
    surface.advance(14)
    expect(surface.currentTime).toBe(10)
    controller.updateLoop({ start: 11, end: 13 })
    surface.advance(13)
    expect(surface.currentTime).toBe(11)
    expect(controller.getState().time).toBe(11)
  })

  it('releases the loop after a seek outside the clip until the next clip is shown', () => {
    const { controller, surface } = showing(true)
    controller.seek(30)
    surface.advance(31)
    expect(surface.currentTime).toBe(31)
    controller.showClip('v1', CLIP, true)
    expect(surface.currentTime).toBe(10)
    surface.advance(14)
    expect(surface.currentTime).toBe(10)
  })

  it('loops the new range after a trim that seeks to an earlier start', () => {
    const { controller, surface } = showing(true)
    // an edit hands the loop its new range before it seeks there
    controller.updateLoop({ start: 9, end: 14 })
    controller.seek(9)
    surface.advance(14)
    expect(surface.currentTime).toBe(9)
  })

  it('keeps a loop the user left released when the range comes to the playhead (I)', () => {
    const { controller, surface } = showing(true)
    controller.seek(8)
    controller.updateLoop({ start: 8, end: 14 })
    surface.advance(14)
    expect(surface.currentTime).toBe(14)
  })

  it('ignores events of surfaces that are no longer shown', () => {
    const { controller } = showing()
    const stale = new FakeSurface(controller)
    stale.play()
    expect(controller.getState().playing).toBe(false)
  })
})

describe('surface changes', () => {
  it('continues on a new surface for the same video (proxy replaced the original)', () => {
    const { controller, surface } = showing(true)
    surface.advance(12)
    controller.detach(surface)
    expect(controller.getState().playing).toBe(false)
    const next = new FakeSurface(controller)
    controller.attach(next, 'v1')
    expect(next.currentTime).toBe(12)
    expect(next.playing).toBe(true)
    expect(controller.getState().playing).toBe(true)
  })

  it('stays paused on the new surface when it was paused, and play works again', () => {
    const { controller, surface } = showing()
    controller.seek(11)
    controller.detach(surface)
    controller.toggle()
    const next = new FakeSurface(controller)
    controller.attach(next, 'v1')
    expect(next.currentTime).toBe(11)
    expect(next.playing).toBe(true)
  })

  it('does nothing when a surface detaches that was never attached', () => {
    const { controller, surface } = showing(true)
    controller.detach(new FakeSurface(controller))
    expect(controller.getState().playing).toBe(true)
    surface.advance(14)
    expect(surface.currentTime).toBe(10)
  })
})

describe('errors', () => {
  it('keeps the error while the same video stays loaded, clears it for another video', () => {
    const controller = new PlaybackController()
    controller.showClip('v1', CLIP, true)
    controller.handleError('This video cannot be played.')
    controller.showClip('v1', { start: 30, end: 34 }, true)
    expect(controller.getState().error).toBe('This video cannot be played.')
    controller.showClip('v2', CLIP, false)
    expect(controller.getState().error).toBeNull()
  })

  it('clears the error once a surface loads', () => {
    const controller = new PlaybackController()
    controller.showClip('v1', CLIP, false)
    controller.handleError('kaputt')
    controller.attach(new FakeSurface(controller), 'v1')
    expect(controller.getState().error).toBeNull()
  })
})

describe('preview of all clips', () => {
  const items = [segment('a', 'v1', 20, 22), segment('b', 'v2', 5, 8)]

  it('plays the clips back to back and returns to the clip shown before', () => {
    const { controller, surface } = showing()
    controller.playSequence(items)
    expect(surface.currentTime).toBe(20)
    expect(controller.getState().playing).toBe(true)
    surface.advance(22)
    expect(controller.getState()).toMatchObject({
      videoId: 'v2',
      time: 5,
      sequence: { index: 1 },
      playing: false
    })
    const second = new FakeSurface(controller)
    controller.attach(second, 'v2')
    expect(second.currentTime).toBe(5)
    expect(second.playing).toBe(true)
    second.advance(8)
    expect(controller.getState()).toMatchObject({
      videoId: 'v1',
      time: 10,
      sequence: null,
      loop: CLIP,
      playing: false
    })
  })

  it('advances within the same video without reloading', () => {
    const { controller, surface } = showing()
    controller.playSequence([segment('a', 'v1', 20, 22), segment('c', 'v1', 40, 43)])
    surface.advance(22)
    expect(surface.currentTime).toBe(40)
    expect(controller.getState()).toMatchObject({ time: 40, sequence: { index: 1 }, playing: true })
  })

  it('hands the playing clip over to the editor without jumping', () => {
    const { controller, surface } = showing()
    controller.playSequence(items)
    surface.advance(21)
    expect(controller.stopSequenceHere()).toMatchObject({ momentId: 'a', start: 20, end: 22 })
    expect(controller.getState()).toMatchObject({
      sequence: null,
      loop: { start: 20, end: 22 },
      playing: true,
      time: 21
    })
    expect(surface.currentTime).toBe(21)
    // the taken-over clip now loops instead of advancing
    surface.advance(22)
    expect(surface.currentTime).toBe(20)
    expect(controller.stopSequenceHere()).toBeNull()
  })

  it('ends without a surface change when stopped on the clip shown before', () => {
    const { controller, surface } = showing()
    controller.playSequence(items)
    surface.advance(21)
    controller.stopSequence()
    expect(controller.getState()).toMatchObject({ sequence: null, loop: CLIP, playing: false })
    expect(surface.currentTime).toBe(10)
  })

  it('starts the preview at the given clip', () => {
    const { controller } = showing()
    controller.playSequence(items, 1)
    expect(controller.getState()).toMatchObject({ videoId: 'v2', time: 5, sequence: { index: 1 } })
    const second = new FakeSurface(controller)
    controller.attach(second, 'v2')
    expect(second.currentTime).toBe(5)
    expect(second.playing).toBe(true)
    controller.stopSequence()
    expect(controller.getState()).toMatchObject({ videoId: 'v1', sequence: null, loop: CLIP })
  })
})
