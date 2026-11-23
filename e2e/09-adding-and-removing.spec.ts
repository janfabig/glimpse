// Flow 9 – adding and removing: a picked folder brings the videos inside it, and a double click on
// a remove button removes exactly one item, although the list moves up under the pointer between
// the two clicks of the double click.

import type { Locator, Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import {
  addVideos,
  createProject,
  expectToast,
  openReview,
  projectState,
  reelIds,
  reelOf,
  startAnalysis,
  suggestionIds,
  waitForAnalysis,
  waitForAutoSelection,
  waitForPrepared
} from './support/flows'
import { TIMEOUTS } from './support/env'
import { copyVideo } from './support/media'

/**
 * A real double click on the remove button of the first of `items`: the first click removes the
 * item, the list moves up – the next item's button is now under the pointer – and then the second
 * click of the double click (detail 2) lands on the same spot.
 */
async function doubleClickWhileTheListMoves(
  page: Page,
  items: Locator,
  buttonTestId: string
): Promise<void> {
  const count = await items.count()
  const box = await items.first().getByTestId(buttonTestId).boundingBox()
  expect(box, 'the remove button is visible').not.toBeNull()
  const x = box!.x + box!.width / 2
  const y = box!.y + box!.height / 2
  await page.mouse.click(x, y)
  await expect(items).toHaveCount(count - 1)
  const underPointer = await page.evaluate(
    ([px, py, testId]) =>
      (document.elementFromPoint(px, py)?.closest(`[data-testid="${testId}"]`) ?? null) !== null,
    [x, y, buttonTestId] as const
  )
  expect(underPointer, 'the next item’s button moved under the pointer').toBe(true)
  await page.mouse.click(x, y, { clickCount: 2 })
  // a second removal would have reached main by now
  await page.waitForTimeout(1_000)
}

test.describe('Flow 9: adding and removing', () => {
  test('a picked folder adds the videos inside it', async ({ hc, videos }) => {
    const { page } = hc
    const folder = join(hc.videoDir, 'Festival Saturday')
    await mkdir(join(folder, 'Subfolder'), { recursive: true })
    await copyVideo(videos.portrait.path, folder, 'Stage 10.mp4')
    await copyVideo(videos.rotated.path, folder, 'Stage 2.mp4')
    // skipped without a word: hidden files, other files, subfolders (one level only)
    await copyVideo(videos.portraitHevc.path, folder, '.hidden.mov')
    await writeFile(join(folder, 'Notes.txt'), 'not a video')
    await copyVideo(videos.landscapeSilent.path, join(folder, 'Subfolder'), 'Deeper.mp4')

    const id = await createProject(hc)
    await hc.pickVideos([folder])
    await page.getByTestId('add-videos').click()
    await expect(page.getByTestId('video-card')).toHaveCount(2, { timeout: TIMEOUTS.prepare })
    await expect(page.getByTestId('video-importing')).toHaveCount(0)
    await expectToast(hc, '2 videos added', { level: 'success' })
    // the picker lets the user choose files and folders
    expect((await hc.openDialogProperties())[0]).toEqual(
      expect.arrayContaining(['openFile', 'openDirectory', 'multiSelections'])
    )
    const project = await projectState(hc, id)
    expect(project.videos.map((video) => video.path).sort()).toEqual(
      [join(folder, 'Stage 10.mp4'), join(folder, 'Stage 2.mp4')].sort()
    )
    expect((await hc.toasts()).filter((shown) => shown.level === 'warning')).toEqual([])

    // a folder without videos says why nothing was added
    const empty = join(hc.videoDir, 'Empty folder')
    await mkdir(empty)
    await hc.pickVideos([empty])
    await page.getByTestId('add-videos').click()
    await expectToast(hc, '“Empty folder” was skipped: This folder has no supported videos.', {
      level: 'warning'
    })
    await expect(page.getByTestId('video-card')).toHaveCount(2)
    await waitForPrepared(hc, 2)
  })

  test('a double click on a remove button removes exactly one item', async ({ hc, videos }) => {
    const { page } = hc
    const id = await createProject(hc)
    await addVideos(hc, [videos.portrait.path, videos.portraitHevc.path, videos.rotated.path])
    await waitForPrepared(hc, 3)

    // Videos step: without clips, X removes a video right away (no dialog)
    const cards = page.getByTestId('video-card')
    const [, second, third] = (await projectState(hc, id)).videos
    await doubleClickWhileTheListMoves(page, cards, 'remove-video')
    await expect(cards).toHaveCount(2)
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0)
    expect((await projectState(hc, id)).videos.map((video) => video.id)).toEqual([
      second.id,
      third.id
    ])

    // Edit: X takes a clip out of the highlight video – the next clip moves up
    await page.getByTestId('next-step').click()
    await startAnalysis(hc)
    await waitForAnalysis(hc, { done: 2 })
    const reel = await waitForAutoSelection(hc, id)
    expect(reel).toHaveLength(2)
    await openReview(hc)
    await expect.poll(() => reelIds(page)).toEqual(reel.map((moment) => moment.id))
    await doubleClickWhileTheListMoves(page, page.getByTestId('clip-item'), 'clip-toggle')
    await expect.poll(() => reelIds(page)).toEqual([reel[1].id])
    expect(reelOf(await projectState(hc, id)).map((moment) => moment.id)).toEqual([reel[1].id])
    await page.getByTestId('tab-suggestions').click()
    expect(await suggestionIds(page)).toEqual([reel[0].id])
  })
})
