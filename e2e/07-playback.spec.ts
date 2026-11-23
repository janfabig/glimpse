// Flow 7 – playback: the review player streams the proxy over hc-media: (with HTTP Range) and
// can seek.

import { stat } from 'node:fs/promises'
import { expect, test } from './fixtures'
import { analysedProject, projectState, reelOf } from './support/flows'

interface VideoElementState {
  src: string
  readyState: number
  currentTime: number
  duration: number
  paused: boolean
  error: number | null
}

test.describe('Flow 7: playback', () => {
  test('the review player loads the proxy over hc-media and seeks', async ({ hc, videos }) => {
    const { page } = hc
    const id = await analysedProject(hc, [videos.portrait.path, videos.portraitHevc.path])
    const project = await projectState(hc, id)
    const active = reelOf(project)[0]
    const video = project.videos.find((v) => v.id === active.videoId)!
    expect(video.proxyPath).toBeTruthy()

    const player = page.getByTestId('player').locator('video')
    await expect(player).toHaveCount(1)
    const state = (): Promise<VideoElementState> =>
      player.evaluate((element: HTMLVideoElement) => ({
        src: element.currentSrc || element.src,
        readyState: element.readyState,
        currentTime: element.currentTime,
        duration: element.duration,
        paused: element.paused,
        error: element.error?.code ?? null
      }))

    // the active (first) clip's video, from its proxy – not the original
    await expect.poll(async () => (await state()).readyState).toBeGreaterThanOrEqual(2)
    const loaded = await state()
    expect(loaded.src.startsWith('hc-media://local/')).toBe(true)
    expect(decodeURIComponent(loaded.src.slice('hc-media://local/'.length))).toBe(video.proxyPath)
    expect(loaded.error).toBeNull()
    expect(loaded.duration).toBeCloseTo(video.durationSec, 0)
    // the player starts at the clip's in point
    expect(loaded.currentTime).toBeCloseTo(active.start, 0)

    // seek: the element reports the new position and has a frame there
    const target = Math.min(video.durationSec - 1, active.end + 2)
    const seeked = await player.evaluate(
      (element: HTMLVideoElement, t) =>
        new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no seeked event')), 15_000)
          element.addEventListener(
            'seeked',
            () => {
              clearTimeout(timer)
              resolve(element.currentTime)
            },
            { once: true }
          )
          element.currentTime = t
        }),
      target
    )
    expect(seeked).toBeCloseTo(target, 1)
    await expect.poll(async () => (await state()).readyState).toBeGreaterThanOrEqual(2)
    expect((await state()).error).toBeNull()

    // play: back to the clip's loop, the time runs; pause stops it
    await page.getByTestId('play-toggle').click()
    await expect.poll(async () => (await state()).paused).toBe(false)
    const startedAt = (await state()).currentTime
    expect(startedAt).toBeGreaterThanOrEqual(active.start - 0.1)
    expect(startedAt).toBeLessThan(active.end)
    await expect.poll(async () => (await state()).currentTime).toBeGreaterThan(startedAt + 0.5)
    await page.getByTestId('play-toggle').click()
    await expect.poll(async () => (await state()).paused).toBe(true)

    // the protocol serves byte ranges (needed for seeking in long videos)
    const size = (await stat(video.proxyPath!)).size
    const range = await hc.app.evaluate(async ({ net }, url) => {
      const response = await net.fetch(url, { headers: { Range: 'bytes=100-1123' } })
      const body = await response.arrayBuffer()
      return {
        status: response.status,
        contentRange: response.headers.get('content-range'),
        acceptRanges: response.headers.get('accept-ranges'),
        length: body.byteLength
      }
    }, loaded.src)
    expect(range).toEqual({
      status: 206,
      contentRange: `bytes 100-1123/${size}`,
      acceptRanges: 'bytes',
      length: 1024
    })
  })
})
