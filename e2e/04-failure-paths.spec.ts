// Flow 4 – failure paths: a video the (fake) analysis rejects, a used-up daily quota, cancelling a
// running analysis, an original deleted before the export, removing videos.

import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import {
  addVideos,
  analysedProject,
  createProject,
  expectToast,
  goToStep,
  projectState,
  reelIds,
  reelOf,
  isRunningStage,
  rowStages,
  screen,
  shortenReel,
  startAnalysis,
  toast,
  waitForAnalysis,
  waitForPrepared
} from './support/flows'
import { TIMEOUTS } from './support/env'
import { copyVideo } from './support/media'
import { ffmpegProcesses } from './support/processes'

const FAKE_FAILURE = 'Gemini could not process the video (test mode).'
const RETRY_HINT = 'You can try again.'
/** the fake analyzer's daily-quota error for the default model (file names with "quota") */
const QUOTA_DAY = /Your daily Gemini quota is used up\. Try again tomorrow/

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

test.describe('Flow 4: failure paths', () => {
  test('a video that fails ends in an error row while the others finish', async ({
    hc,
    videos
  }) => {
    const { page } = hc
    const failing = await copyVideo(videos.portrait.path, hc.videoDir, 'Aftermovie fail.mp4')
    const id = await createProject(hc)
    await addVideos(hc, [videos.portrait.path, failing, videos.rotated.path])
    await waitForPrepared(hc, 3)
    await page.getByTestId('next-step').click()
    await startAnalysis(hc)
    await waitForAnalysis(hc, { done: 2, error: 1 })

    const errorRow = page.locator('[data-testid="analysis-row"][data-stage="error"]')
    await expect(errorRow).toContainText('Aftermovie fail.mp4')
    await expect(errorRow).toContainText(FAKE_FAILURE)
    // a temporary problem: trying again can help
    await expect(errorRow.getByTestId('retry-analysis')).toHaveText('Try again')
    await expect(errorRow.getByTestId('analysis-open-settings')).toHaveCount(0)
    const summary = page.getByTestId('analysis-summary')
    await expect(summary).toContainText('1 video failed')
    await expect(page.getByTestId('analysis-failure-reason')).toHaveText(FAKE_FAILURE)
    await expect(summary).toContainText('2 videos are analysed')
    await expect(page.getByTestId('retry-failed')).toBeVisible()
    await expectToast(hc, `1 video could not be analysed: ${FAKE_FAILURE} ${RETRY_HINT}`, {
      level: 'warning'
    })

    const project = await projectState(hc, id)
    const failed = project.videos.find((v) => v.fileName === 'Aftermovie fail.mp4')!
    expect(project.status[failed.id].analysis).toMatchObject({
      stage: 'error',
      error: FAKE_FAILURE,
      remedy: 'retry'
    })
    expect(project.moments.filter((m) => m.videoId === failed.id)).toEqual([])
    // the two good videos are in the reel
    expect(reelOf(project)).toHaveLength(2)

    // "Try again" runs the failing video again – and it fails again, nothing else changes
    const firstFinish = project.status[failed.id].analysis.finishedAt
    await errorRow.getByTestId('retry-analysis').click()
    await expectToast(hc, `The analysis failed: ${FAKE_FAILURE} ${RETRY_HINT}`, {
      level: 'error',
      timeout: TIMEOUTS.analysis
    })
    await expect
      .poll(async () => (await projectState(hc, id)).status[failed.id].analysis.finishedAt)
      .not.toBe(firstFinish)
    await waitForAnalysis(hc, { done: 2, error: 1 })
    expect(reelOf(await projectState(hc, id)).map((m) => m.id)).toEqual(
      reelOf(project).map((m) => m.id)
    )

    await page.getByTestId('go-review').click()
    await expect(screen(page, 'review')).toBeVisible()
    await expect(page.getByTestId('clip-item')).toHaveCount(2)
  })

  test('a used-up daily quota points to the settings – and the video can be tried again after', async ({
    hc,
    videos
  }) => {
    const { page } = hc
    const quota = await copyVideo(videos.portrait.path, hc.videoDir, 'Daily limit quota.mp4')
    const id = await createProject(hc)
    await addVideos(hc, [videos.rotated.path, quota])
    await waitForPrepared(hc, 2)
    await page.getByTestId('next-step').click()
    await startAnalysis(hc)
    await waitForAnalysis(hc, { done: 1, error: 1 })

    // trying the same again will not help today: the row and the summary lead to the settings
    const errorRow = page.locator('[data-testid="analysis-row"][data-stage="error"]')
    await expect(errorRow).toContainText('Daily limit quota.mp4')
    await expect(errorRow).toContainText(QUOTA_DAY)
    await expect(errorRow.getByTestId('analysis-open-settings')).toHaveText('Open Settings')
    await expect(page.getByTestId('analysis-failure-reason')).toHaveText(QUOTA_DAY)
    await expect(page.getByTestId('failed-open-settings')).toBeVisible()
    // … and once that is fixed (another model, billing, the next day) the video can be tried again
    await expect(errorRow.getByTestId('retry-analysis')).toHaveText('Try again')
    await expect(page.getByTestId('retry-failed')).toHaveText('Retry failed videos')
    await expectToast(hc, /^1 video could not be analysed: Your daily Gemini quota/, {
      level: 'warning'
    })
    expect((await hc.toasts()).some((shown) => shown.text.includes(RETRY_HINT))).toBe(false)

    const project = await projectState(hc, id)
    const failed = project.videos.find((v) => v.fileName === 'Daily limit quota.mp4')!
    const good = project.videos.find((v) => v.fileName !== 'Daily limit quota.mp4')!
    expect(project.status[failed.id].analysis).toMatchObject({ stage: 'error', remedy: 'settings' })
    expect(project.status[failed.id].analysis.error).toMatch(QUOTA_DAY)
    expect(reelOf(project)).toHaveLength(1)

    // the button opens the settings (model, key, billing): switch to the cheaper model
    await errorRow.getByTestId('analysis-open-settings').click()
    await expect(page.getByTestId('settings-modal')).toBeVisible()
    await page.getByTestId('model-select').selectOption('gemini-3.5-flash-lite')
    await page.getByTestId('close-settings').click()
    await expect(page.getByTestId('settings-modal')).toHaveCount(0)

    // the summary's retry analyses exactly the failed video, with the new model – not the others
    const firstFinish = project.status[failed.id].analysis.finishedAt
    await page.getByTestId('retry-failed').click()
    await expect
      .poll(async () => (await projectState(hc, id)).status[failed.id].analysis.finishedAt, {
        timeout: TIMEOUTS.analysis
      })
      .not.toBe(firstFinish)
    await waitForAnalysis(hc, { done: 1, error: 1 })
    const after = await projectState(hc, id)
    expect(after.analyses[good.id]).toEqual(project.analyses[good.id])
    // the fake analyzer fails every "quota" file – on Flash-Lite it no longer suggests Flash-Lite
    expect(after.status[failed.id].analysis.error).toMatch(QUOTA_DAY)
    expect(after.status[failed.id].analysis.error).not.toContain('Flash-Lite')
    expect(project.status[failed.id].analysis.error).toContain('Flash-Lite')
  })

  test('cancelling a running analysis stops it and "Continue" finishes it', async ({
    hc,
    videos
  }) => {
    const { page } = hc
    const id = await createProject(hc)
    await addVideos(hc, [videos.portrait.path, videos.portraitHevc.path, videos.rotated.path])
    // start right away: the analysis waits for the previews that are still being made
    await page.getByTestId('next-step').click()
    await startAnalysis(hc)
    await expect.poll(async () => (await rowStages(page)).some(isRunningStage)).toBe(true)
    await page.getByTestId('cancel-analysis').click()

    await expect.poll(async () => (await rowStages(page)).filter(isRunningStage)).toEqual([])
    const stages = await rowStages(page)
    expect(stages, 'at least one video was cancelled').toContain('cancelled')
    expect(stages).not.toContain('error')
    await expect(page.getByTestId('cancel-analysis')).toHaveCount(0)
    await expect(page.getByTestId('analysis-summary')).toContainText('Analysis cancelled')
    const cancelledRow = page.locator('[data-testid="analysis-row"][data-stage="cancelled"]')
    await expect(cancelledRow.first()).toContainText('Cancelled')
    await expect(cancelledRow.first().getByTestId('retry-analysis')).toBeVisible()

    // the previews were not part of the cancel
    await goToStep(hc, 'videos')
    await waitForPrepared(hc, 3)

    // "Continue" analyses what is missing
    await goToStep(hc, 'analysis')
    await page.getByTestId('resume-analysis').click()
    await waitForAnalysis(hc, { done: 3 })
    const project = await projectState(hc, id)
    expect(Object.keys(project.analyses)).toHaveLength(3)
    expect(reelOf(project).length).toBeGreaterThan(0)
  })

  test('an original deleted before the export gives an error naming the file', async ({
    hc,
    videos
  }) => {
    const { page } = hc
    const fileName = 'Grüße vom Fluss – Tänze.mp4'
    const copy = await copyVideo(videos.rotated.path, hc.videoDir, fileName)
    const id = await analysedProject(hc, [videos.portrait.path, videos.portraitHevc.path, copy])
    const project = await projectState(hc, id)
    const video = project.videos.find((v) => v.fileName === fileName)!
    expect(
      reelOf(project).some((m) => m.videoId === video.id),
      'its clip is in the reel'
    ).toBe(true)
    // should main ever miss the deleted file, the render that starts is 1 s per clip at 4K
    await shortenReel(hc, id)

    await page.getByTestId('go-export').click()
    await expect(screen(page, 'export')).toBeVisible()
    await rm(copy)
    await page.getByTestId('start-export').click()
    const error = toast(
      page,
      `The original file “${fileName}” was not found. Was it moved? Then add it again from its new place. Your clips are kept.`
    )
    await expect(error).toBeVisible()
    await expect(error).toHaveAttribute('data-level', 'error')
    await expect(page.getByTestId('export-progress')).toHaveCount(0)
    await expect(page.getByTestId('start-export')).toBeEnabled()
    expect(await readdir(hc.outputDir).catch(() => [])).toEqual([])
    expect((await projectState(hc, id)).exports).toEqual([])
  })

  test('removing videos: with clips after asking, while preparing right away', async ({
    hc,
    videos
  }) => {
    const { page } = hc
    const id = await analysedProject(hc, [
      videos.portrait.path,
      videos.portraitHevc.path,
      videos.rotated.path
    ])
    const before = await projectState(hc, id)
    const victim = before.videos.find((v) => v.fileName === videos.portraitHevc.fileName)!
    const victimClips = before.moments.filter((m) => m.videoId === victim.id).map((m) => m.id)
    expect(victimClips.length).toBeGreaterThan(0)
    const mediaDir = join(hc.userDataDir, 'projects', id, 'media', victim.id)
    expect(await exists(mediaDir)).toBe(true)

    // a video with clips: the app asks first
    await goToStep(hc, 'videos')
    const card = page.getByTestId('video-card').filter({ hasText: victim.fileName })
    await card.getByTestId('remove-video').click()
    const dialog = page.getByTestId('confirm-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Remove video?')
    await page.getByTestId('confirm-ok').click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('video-card')).toHaveCount(2)
    await expect(card).toHaveCount(0)

    const after = await projectState(hc, id)
    expect(after.videos.map((v) => v.id)).not.toContain(victim.id)
    expect(after.moments.filter((m) => m.videoId === victim.id)).toEqual([])
    expect(after.status[victim.id]).toBeUndefined()
    expect(after.analyses[victim.id]).toBeUndefined()
    await expect.poll(() => exists(mediaDir)).toBe(false)
    await goToStep(hc, 'review')
    await expect.poll(() => reelIds(page)).toHaveLength(2)
    expect(await reelIds(page)).not.toEqual(expect.arrayContaining(victimClips))

    // a video without clips that is still being prepared goes right away, its ffmpeg stops. Its X
    // sits where the removed video's X was clicked – often less than 500 ms ago; the clicks in
    // between (dialog, steps, "Add videos") show that this click is meant (lib/click-guard.ts)
    await goToStep(hc, 'videos')
    const late = await copyVideo(videos.portrait.path, hc.videoDir, 'Added later.mp4')
    await addVideos(hc, [late])
    const added = (await projectState(hc, id)).videos.find((v) => v.fileName === 'Added later.mp4')!
    const fresh = page.getByTestId('video-card').filter({ hasText: added.fileName })
    await expect(fresh).toHaveAttribute('data-prepare', /^(pending|running)$/)
    await fresh.getByTestId('remove-video').click()
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0)
    await expect(fresh).toHaveCount(0)
    await expect(page.getByTestId('video-card')).toHaveCount(2)
    const addedDir = join(hc.userDataDir, 'projects', id, 'media', added.id)
    await expect.poll(() => exists(addedDir)).toBe(false)
    await expect.poll(() => ffmpegProcesses(addedDir)).toEqual([])
    expect((await projectState(hc, id)).videos).toHaveLength(2)
  })
})
