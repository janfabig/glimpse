// Flow 5 – persistence: quit and relaunch on the same HC_USER_DATA_DIR. The project with its
// moments, selection and order comes back, and no stage is left running – also after quitting or
// crashing in the middle of the background work.

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Project } from '../src/shared/types'
import { expect, test } from './fixtures'
import type { HcApp } from './support/app'
import {
  addVideos,
  analysedProject,
  clipItem,
  createProject,
  goToStep,
  projectState,
  reelIds,
  isRunningStage,
  RUNNING_STAGES,
  rowStages,
  screen,
  startAnalysis,
  suggestionIds,
  totalSec,
  waitForAnalysis,
  waitForPrepared
} from './support/flows'

/** what a restart must keep */
function persistent(project: Project): unknown {
  return {
    name: project.name,
    reelEdited: project.reelEdited,
    brief: project.brief,
    exportSettings: project.exportSettings,
    videos: project.videos,
    analyses: project.analyses,
    moments: project.moments
  }
}

/** running previews and analyses ("<file>: prepare running", "<file>: analysis uploading") */
function runningStages(project: Project): string[] {
  return project.videos.flatMap((video) => {
    const status = project.status[video.id]
    const stuck: string[] = []
    if (status.prepare.status === 'running') stuck.push(`${video.fileName}: prepare running`)
    if (RUNNING_STAGES.includes(status.analysis.stage)) {
      stuck.push(`${video.fileName}: analysis ${status.analysis.stage}`)
    }
    return stuck
  })
}

/** analyses never resume on their own after a restart (previews do – those are new jobs) */
function runningAnalyses(project: Project): string[] {
  return runningStages(project).filter((stage) => stage.includes(': analysis '))
}

async function readProjectFile(hc: HcApp, id: string): Promise<Project> {
  return JSON.parse(
    await readFile(join(hc.userDataDir, 'projects', id, 'project.json'), 'utf8')
  ) as Project
}

/** home → project card → the project opens */
async function openFromHome(hc: HcApp, name: string): Promise<void> {
  const card = hc.page.getByTestId('project-card').filter({ hasText: name })
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: `Open ${name}` }).click()
  await expect(hc.page.getByTestId('project-name')).toHaveText(name)
}

test.describe('Flow 5: persistence', () => {
  test('project, moments, selection and order are back after a restart', async ({ hc, videos }) => {
    const { page } = hc
    const id = await analysedProject(hc, [
      videos.portrait.path,
      videos.portraitHevc.path,
      videos.rotated.path
    ])
    const [a, b, c] = await reelIds(page)
    expect(c, 'three clips in the reel').toBeTruthy()

    // edit everything that has to survive: name, order, selection, a trim
    await page.getByTestId('project-name').click()
    await page.getByRole('textbox', { name: 'Project name' }).fill('Persistence – night market')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('project-name')).toHaveText('Persistence – night market')
    await clipItem(page, a).getByTestId('clip-move-down').click()
    await expect.poll(() => reelIds(page)).toEqual([b, a, c])
    await clipItem(page, c).getByTestId('clip-toggle').click()
    await expect.poll(() => reelIds(page)).toEqual([b, a])
    await clipItem(page, b).locator('.clip__main').click()
    const lengthBefore = await totalSec(page)
    await page.getByTestId('nudge-out-minus').click()
    await expect.poll(() => totalSec(page)).toBeCloseTo(lengthBefore - 0.5, 1)
    const before = await projectState(hc, id)
    expect(before.reelEdited).toBe(true)
    const reelLengthBefore = await totalSec(page)

    await hc.close()
    // written to disk on quit
    expect(persistent(await readProjectFile(hc, id))).toEqual(persistent(before))

    await hc.launch()
    await expect(screen(hc.page, 'home')).toBeVisible()
    await expect(hc.page.getByTestId('project-card')).toHaveCount(1)
    await expect(hc.page.getByTestId('project-card')).toContainText('2 clips selected')
    await openFromHome(hc, 'Persistence – night market')
    // a project with moments opens in the review, with the same reel
    await expect(screen(hc.page, 'review')).toBeVisible()
    await expect.poll(() => reelIds(hc.page)).toEqual([b, a])
    expect(await totalSec(hc.page)).toBeCloseTo(reelLengthBefore, 1)
    await hc.page.getByTestId('tab-suggestions').click()
    expect(await suggestionIds(hc.page)).toEqual([c])

    const after = await projectState(hc, id)
    expect(persistent(after)).toEqual(persistent(before))
    expect(runningStages(after)).toEqual([])
    for (const video of after.videos) {
      expect(after.status[video.id].prepare.status).toBe('done')
      expect(after.status[video.id].analysis.stage).toBe('done')
    }
  })

  test('a project saved by a version with more prompt options and own clips opens without asking for a new analysis', async ({
    hc,
    videos
  }) => {
    const id = await analysedProject(hc, [videos.portrait.path, videos.rotated.path])
    const before = await projectState(hc, id)
    await hc.close()

    // the project file as that (German) version wrote it: the brief had a preset, clip lengths and an
    // analysis quality, and the hash of every analysis covered the last three; every moment had an
    // origin, and the user could add own clips (no AI times). It also stored what nobody read:
    // probe details per video, Gemini's summary and tags, the token usage
    const file = join(hc.userDataDir, 'projects', id, 'project.json')
    const saved = await readProjectFile(hc, id)
    const options = { minClipSec: 2, maxClipSec: 8, analysisQuality: 'balanced' }
    const oldHash = (model: string): string =>
      createHash('sha1')
        .update(JSON.stringify({ prompt: saved.brief.prompt.trim(), ...options, model }))
        .digest('hex')
        .slice(0, 12)
    const analyses = Object.entries(saved.analyses).map(([videoId, analysis]) => [
      videoId,
      {
        ...analysis,
        briefHash: oldHash(analysis.model),
        summary: 'Ein Abend.',
        usage: null,
        momentCount: 1
      }
    ])
    expect(analyses).toHaveLength(2)
    const own = {
      id: 'own-clip-1',
      videoId: saved.videos[0].id,
      start: 0.5,
      end: 2.5,
      title: 'Mein Lieblingsmoment',
      reason: 'Von dir hinzugefügt.',
      score: 10,
      selected: true
    }
    await writeFile(
      file,
      JSON.stringify({
        ...saved,
        videos: saved.videos.map((v) => ({ ...v, rotation: 0, fps: 30, videoCodec: 'h264' })),
        brief: { ...saved.brief, presetId: 'festival', ...options },
        analyses: Object.fromEntries(analyses),
        moments: [
          ...saved.moments.map((moment) => ({ ...moment, origin: 'ai', tags: ['Drop'] })),
          { ...own, origin: 'manual', tags: [] }
        ]
      })
    )

    await hc.launch()
    await openFromHome(hc, 'New highlight video')
    await expect(screen(hc.page, 'review')).toBeVisible()
    // the removed options and fields are gone, everything else is as it was; the own clip is a
    // clip like Gemini's now, still in the highlight video
    const reopened = await projectState(hc, id)
    expect(reopened.brief).toEqual(before.brief)
    expect(persistent(reopened)).toEqual(
      persistent({ ...before, moments: [...before.moments, own] })
    )
    await expect(clipItem(hc.page, own.id)).toContainText('Mein Lieblingsmoment')
    // Prompt: nothing to analyse, the old results count for the unchanged prompt
    await goToStep(hc, 'brief')
    await expect(hc.page.locator('.step__hint')).toContainText(
      'All videos are already analysed with this prompt.'
    )
    await expect(hc.page.getByTestId('start-analysis')).toHaveText('Analyse again')
  })

  test('quitting during the previews and the analysis leaves nothing running', async ({
    hc,
    videos
  }) => {
    const { page } = hc
    const id = await createProject(hc)
    await addVideos(hc, [videos.portrait.path, videos.portraitHevc.path, videos.rotated.path])
    await page.getByTestId('next-step').click()
    await startAnalysis(hc)
    await expect.poll(async () => (await rowStages(page)).some(isRunningStage)).toBe(true)
    expect(runningStages(await projectState(hc, id)).length).toBeGreaterThan(0)

    await hc.close()
    expect(runningStages(await readProjectFile(hc, id))).toEqual([])

    await hc.launch()
    await openFromHome(hc, 'New highlight video')
    // opening the project restarts the missing previews; the analysis waits for the user
    expect(runningAnalyses(await projectState(hc, id))).toEqual([])
    await goToStep(hc, 'videos')
    await waitForPrepared(hc, 3)
    await goToStep(hc, 'analysis')
    await expect(hc.page.getByTestId('cancel-analysis')).toHaveCount(0)
    // the quit cancelled the run: "Continue" analyses the rest
    await hc.page.getByTestId('resume-analysis').click()
    await waitForAnalysis(hc, { done: 3 })
  })

  test('a crash in the middle of the work leaves nothing running after the restart', async ({
    hc,
    videos
  }) => {
    const { page } = hc
    const id = await createProject(hc)
    await addVideos(hc, [videos.portrait.path, videos.portraitHevc.path, videos.rotated.path])
    await page.getByTestId('next-step').click()
    await startAnalysis(hc)
    // wait until a running analysis reached the disk (writes are debounced), then kill the app
    const analysing = async (): Promise<number> =>
      runningAnalyses(await readProjectFile(hc, id)).length
    await expect.poll(analysing, { timeout: 30_000 }).toBeGreaterThan(0)
    await hc.crash()
    expect(await analysing()).toBeGreaterThan(0)

    // loading the project resets every running stage and writes that back, before it is opened
    await hc.launch()
    await expect
      .poll(async () => runningStages(await readProjectFile(hc, id)), { timeout: 10_000 })
      .toEqual([])
    await openFromHome(hc, 'New highlight video')
    const reopened = await projectState(hc, id)
    expect(runningAnalyses(reopened)).toEqual([])
    // the analyses that were running are marked as interrupted
    const interrupted = reopened.videos.filter(
      (video) => reopened.status[video.id].analysis.stage === 'cancelled'
    )
    expect(interrupted.length).toBeGreaterThan(0)
    for (const video of interrupted) {
      expect(reopened.status[video.id].analysis.message).toBe('Interrupted')
    }
    await goToStep(hc, 'videos')
    await waitForPrepared(hc, 3)
    await goToStep(hc, 'analysis')
    await expect(
      hc.page.locator('[data-testid="analysis-row"][data-stage="cancelled"]').first()
    ).toContainText('Interrupted')
    await hc.page.getByTestId('resume-analysis').click()
    await waitForAnalysis(hc, { done: 3 })
  })
})
