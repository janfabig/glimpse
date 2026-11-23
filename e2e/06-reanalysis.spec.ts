// Flow 6 – re-analysis keeps a reel edited by hand (src/main/core/jobs/analysis.ts, finish()):
// re-running one video replaces only that video's AI clips; every other clip keeps its selection,
// its place in the reel and its trim. The new moments wait under "More suggestions".

import type { Moment, Project } from '../src/shared/types'
import { expect, test } from './fixtures'
import {
  analysedProject,
  clipItem,
  goToStep,
  projectState,
  reelIds,
  reelOf,
  rowStages,
  isRunningStage,
  screen,
  suggestionIds,
  toast,
  waitForAnalysis
} from './support/flows'
import { TIMEOUTS } from './support/env'

/** order, selection and times of every moment except those of `videoId` */
function othersOf(
  project: Project,
  videoId: string
): Pick<Moment, 'id' | 'selected' | 'start' | 'end'>[] {
  return project.moments
    .filter((m) => m.videoId !== videoId)
    .map(({ id, selected, start, end }) => ({ id, selected, start, end }))
}

test.describe('Flow 6: re-analysis keeps an edited reel', () => {
  test('retrying one video replaces only its clip – order, selection and trims of the others stay', async ({
    hc,
    videos
  }) => {
    const { page } = hc
    const id = await analysedProject(hc, [
      videos.portrait.path,
      videos.portraitHevc.path,
      videos.rotated.path,
      videos.landscapeSilent.path
    ])
    const analysed = await projectState(hc, id)
    const [a, b, c, d] = reelOf(analysed).map((m) => m.id)
    expect(d, 'all four clips are in the automatic reel').toBeTruthy()
    const videoOf = (momentId: string): string =>
      analysed.moments.find((m) => m.id === momentId)!.videoId

    // edit the reel by hand: order [c, a, d], b out, a trimmed
    await clipItem(page, c).getByTestId('clip-move-up').click()
    await expect.poll(() => reelIds(page)).toEqual([a, c, b, d])
    await clipItem(page, c).getByTestId('clip-move-up').click()
    await expect.poll(() => reelIds(page)).toEqual([c, a, b, d])
    await clipItem(page, b).getByTestId('clip-toggle').click()
    await expect.poll(() => reelIds(page)).toEqual([c, a, d])
    await clipItem(page, a).locator('.clip__main').click()
    await page.getByTestId('nudge-out-minus').click()
    await expect
      .poll(async () => (await projectState(hc, id)).moments.find((m) => m.id === a)!.end)
      .toBeCloseTo(analysed.moments.find((m) => m.id === a)!.end - 0.5, 2)
    expect((await projectState(hc, id)).reelEdited).toBe(true)

    // "Analyse again" asks first (the edited reel would lose its clips), then cancel right away:
    // two videos are analysed at a time, so the third and fourth still wait
    await goToStep(hc, 'brief')
    await page.getByTestId('start-analysis').click()
    const dialog = page.getByTestId('confirm-dialog')
    await expect(dialog).toContainText('Gemini looks at 4 videos again')
    await page.getByTestId('confirm-ok').click()
    await page.getByTestId('cancel-analysis').click()
    await expect.poll(async () => (await rowStages(page)).filter(isRunningStage)).toEqual([])
    const stagesAfterCancel = await rowStages(page)
    // the third video waited in the queue, so it was cancelled before Gemini (fake) saw it
    expect(stagesAfterCancel[2]).toBe('cancelled')
    if (stagesAfterCancel.slice(0, 2).includes('done')) {
      test.info().annotations.push({
        type: 'timing',
        description: 'one of the first two videos finished before the cancel arrived'
      })
    }

    // "Try again" for the third video only (d keeps the reel alive in any case)
    const before = await projectState(hc, id)
    const videoC = videoOf(c)
    const reelBefore = reelOf(before).map((m) => m.id)
    expect(reelBefore).toContain(c)
    const row = page.getByTestId('analysis-row').nth(2)
    await expect(row).toContainText(videos.rotated.fileName)
    await row.getByTestId('retry-analysis').click()
    await expect(dialog).toContainText(
      'Gemini looks at the video again and replaces its earlier suggestions.'
    )
    await expect(dialog).toContainText('1 clip disappears from your highlight video.')
    await page.getByTestId('confirm-ok').click()
    await expect(
      toast(
        page,
        'Analysis done: 1 new suggestion. Your selection stays. You can find the new moment under “More suggestions”.'
      )
    ).toBeVisible({ timeout: TIMEOUTS.analysis })
    await expect(row).toHaveAttribute('data-stage', 'done')

    const after = await projectState(hc, id)
    // only c left the reel; the rest keeps order, selection and times
    expect(reelOf(after).map((m) => m.id)).toEqual(reelBefore.filter((momentId) => momentId !== c))
    expect(othersOf(after, videoC)).toEqual(othersOf(before, videoC))
    expect(after.reelEdited).toBe(true)
    // the video got new AI moments, unselected
    const fresh = after.moments.filter((m) => m.videoId === videoC)
    expect(fresh.length).toBeGreaterThan(0)
    for (const moment of fresh) {
      expect(moment.id).not.toBe(c)
      expect(moment).toMatchObject({ selected: false })
    }
    expect(after.analyses[videoC].createdAt > before.analyses[videoC].createdAt).toBe(true)

    // the review shows the kept reel and offers the new moment
    await goToStep(hc, 'review')
    await expect.poll(() => reelIds(page)).toEqual(reelOf(after).map((m) => m.id))
    await page.getByTestId('tab-suggestions').click()
    const suggestions = await suggestionIds(page)
    for (const moment of fresh) expect(suggestions).toContain(moment.id)

    // "Auto-select" asks before replacing the edited reel; own trims survive it
    await page.getByTestId('auto-select').click()
    await expect(dialog).toContainText('Auto-select again?')
    await page.getByTestId('confirm-ok').click()
    await expect(toast(page, /^Auto-selected: /)).toBeVisible()
    const rebuilt = await projectState(hc, id)
    expect(rebuilt.reelEdited).toBe(false)
    // a's video was only replaced when it finished before the cancel (see annotation)
    const trimmed = after.moments.find((m) => m.id === a)
    if (trimmed) expect(rebuilt.moments.find((m) => m.id === a)?.end).toBe(trimmed.end)
  })
})

// "Ask Gemini again" (src/main/core/jobs/analysis.ts, start() with a wish): one step in main.
test.describe('Flow 6: "Ask Gemini again"', () => {
  test('the note joins the prompt, every video is analysed again with its earlier clips, the reel is put together anew', async ({
    hc,
    videos
  }) => {
    const { page } = hc
    const id = await analysedProject(hc, [videos.portrait.path, videos.landscapeSilent.path])
    const analysed = await projectState(hc, id)
    const [first] = reelOf(analysed)

    // an edit by hand, which the run replaces: the first clip trimmed
    await clipItem(page, first.id).locator('.clip__main').click()
    await page.getByTestId('nudge-out-minus').click()
    await expect.poll(async () => (await projectState(hc, id)).reelEdited).toBe(true)
    const before = await projectState(hc, id)
    expect(before.moments.find((m) => m.id === first.id)!.end).toBeCloseTo(first.end - 0.5, 2)

    // the dialog says what happens and starts only with a text
    await page.getByTestId('again-open').click()
    const dialog = page.getByTestId('again-dialog')
    await expect(dialog).toContainText('Gemini looks at all 2 videos again, one request per video.')
    await expect(dialog).toContainText('What should Gemini do differently?')
    await expect(dialog).toContainText('Everything Gemini has suggested so far is replaced')
    const start = page.getByTestId('again-start')
    await expect(start).toBeDisabled()
    await page.getByTestId('again-wish').fill('More crowd, less stage.')
    await start.click()

    // the usual analysis screen; every video runs again
    await expect(screen(page, 'analysis')).toBeVisible()
    await waitForAnalysis(hc, { done: 2 })
    const after = await projectState(hc, id)
    expect(after.brief.prompt).toBe(`${before.brief.prompt.trim()}\nMore crowd, less stage.`)
    for (const video of after.videos) {
      expect(after.analyses[video.id].createdAt > before.analyses[video.id].createdAt).toBe(true)
      // the fake analyzer reports what it got: this video's clips from before the run, and the wish
      const earlier = before.moments.filter((m) => m.videoId === video.id)
      const inReel = earlier.filter((m) => m.selected).length
      expect(earlier.length).toBeGreaterThan(0)
      const fresh = after.moments.filter((m) => m.videoId === video.id)
      expect(fresh.length).toBeGreaterThan(0)
      for (const moment of fresh) {
        expect(moment.reason).toContain(
          `Second pass: saw ${earlier.length} earlier clips (${inReel} in the highlight video), note: “More crowd, less stage.”`
        )
      }
    }

    // everything suggested before is replaced, the trim is gone, the reel is the automatic one again
    const earlierIds = new Set(before.moments.map((m) => m.id))
    expect(after.moments.filter((m) => earlierIds.has(m.id))).toEqual([])
    const again = after.moments.find(
      (m) => m.videoId === first.videoId && m.aiStart === first.aiStart
    )
    expect(again?.end).toBe(first.end)
    expect(after.reelEdited).toBe(false)
    expect(reelOf(after).length).toBeGreaterThan(0)

    // the Prompt step shows the new line (it can be edited there), the Edit step the new reel
    await goToStep(hc, 'brief')
    await expect(page.getByTestId('brief-prompt')).toHaveValue(after.brief.prompt)
    await goToStep(hc, 'review')
    await expect.poll(() => reelIds(page)).toEqual(reelOf(after).map((m) => m.id))
  })
})
