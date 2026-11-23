// UI steps shared by the specs. They click through the app like a user (data-testids from
// docs/ARCHITECTURE.md §8) and read the project state from main through window.api.

import { expect, type Locator, type Page } from '@playwright/test'
import { EXPORT_FIXED } from '../../src/shared/presets'
import type { AnalysisStage, Moment, Project } from '../../src/shared/types'
import type { HcApp } from './app'
import { TIMEOUTS } from './env'

export const RUNNING_STAGES: readonly AnalysisStage[] = [
  'queued',
  'waiting-proxy',
  'uploading',
  'processing',
  'analyzing'
]

/** a row stage (data-stage) of an analysis that is still going */
export function isRunningStage(stage: string): boolean {
  return (RUNNING_STAGES as readonly string[]).includes(stage)
}

export function screen(page: Page, name: string): Locator {
  return page.locator(`[data-screen="${name}"]`)
}

/** home → "New highlight video"; returns the id of the new project */
export async function createProject(hc: HcApp): Promise<string> {
  const before = new Set((await hc.api('listProjects')).map((p) => p.id))
  await hc.page.getByTestId('new-project').click()
  await expect(screen(hc.page, 'videos')).toBeVisible()
  const created = (await hc.api('listProjects')).filter((p) => !before.has(p.id))
  expect(created, 'exactly one new project').toHaveLength(1)
  return created[0].id
}

/** "Add videos" through the stubbed file dialog; waits until every file has its card */
export async function addVideos(hc: HcApp, paths: string[]): Promise<void> {
  const cards = hc.page.getByTestId('video-card')
  const before = await cards.count()
  await hc.pickVideos(paths)
  await hc.page.getByTestId('add-videos').click()
  await expect(cards).toHaveCount(before + paths.length, { timeout: TIMEOUTS.prepare })
  await expect(hc.page.getByTestId('video-importing')).toHaveCount(0)
}

/** videos step: every card shows a finished preview (proxy + filmstrip) */
export async function waitForPrepared(hc: HcApp, count: number): Promise<void> {
  await expect(hc.page.locator('[data-testid="video-card"][data-prepare="done"]')).toHaveCount(
    count,
    { timeout: TIMEOUTS.prepare }
  )
}

export async function goToStep(hc: HcApp, step: string, screenName = step): Promise<void> {
  await hc.page.getByTestId(`step-${step}`).click()
  await expect(screen(hc.page, screenName)).toBeVisible()
}

export interface BriefChoice {
  /** seconds; null = "No limit" */
  target?: number | null
}

/** Prompt step: optional target length (confirmed by main), no start yet */
export async function setBrief(hc: HcApp, choice: BriefChoice): Promise<void> {
  const page = hc.page
  await expect(screen(page, 'brief')).toBeVisible()
  if (choice.target !== undefined) {
    const option = page.getByTestId(
      choice.target === null ? 'target-none' : `target-${choice.target}`
    )
    await option.click()
    await expect(option).toHaveAttribute('aria-checked', 'true')
  }
}

/** Prompt step → "Analyse with Gemini" → analysis screen */
export async function startAnalysis(hc: HcApp, choice: BriefChoice = {}): Promise<void> {
  await setBrief(hc, choice)
  await hc.page.getByTestId('start-analysis').click()
  await expect(screen(hc.page, 'analysis')).toBeVisible()
}

/** stages of the analysis rows, in video order */
export async function rowStages(page: Page): Promise<string[]> {
  return page
    .getByTestId('analysis-row')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-stage') ?? ''))
}

function countStages(stages: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const stage of stages) counts[stage] = (counts[stage] ?? 0) + 1
  return counts
}

/** waits until the analysis rows settled exactly into `expected`, e.g. { done: 2, error: 1 } */
export async function waitForAnalysis(
  hc: HcApp,
  expected: Partial<Record<AnalysisStage, number>>
): Promise<void> {
  await expect
    .poll(async () => countStages(await rowStages(hc.page)), {
      timeout: TIMEOUTS.analysis,
      intervals: [250, 500, 1000]
    })
    .toEqual(expected)
}

export async function openReview(hc: HcApp): Promise<void> {
  const button = hc.page.getByTestId('go-review')
  await expect(button).toBeEnabled()
  await button.click()
  await expect(screen(hc.page, 'review')).toBeVisible()
}

/**
 * After a run of a fresh project: main selects the reel in the same project update in which the
 * last row turns "done". Checks that main picked clips and that the analysis summary shows them.
 */
export async function waitForAutoSelection(hc: HcApp, id: string): Promise<Moment[]> {
  const reel = reelOf(await projectState(hc, id))
  expect(reel.length, 'the automatic selection picked clips').toBeGreaterThan(0)
  await expect(hc.page.getByTestId('analysis-summary')).toContainText(
    reel.length === 1 ? '1 of them is already' : `${reel.length} of them are already`
  )
  return reel
}

/**
 * Creates a project with `paths`, waits for the previews, runs the (fake) analysis and opens
 * the review with the automatic reel. Returns the project id.
 */
export async function analysedProject(
  hc: HcApp,
  paths: string[],
  choice: BriefChoice = {}
): Promise<string> {
  const id = await createProject(hc)
  await addVideos(hc, paths)
  await waitForPrepared(hc, paths.length)
  await hc.page.getByTestId('next-step').click()
  await startAnalysis(hc, choice)
  await waitForAnalysis(hc, { done: paths.length })
  const reel = await waitForAutoSelection(hc, id)
  await openReview(hc)
  await expect.poll(() => reelIds(hc.page)).toEqual(reel.map((moment) => moment.id))
  return id
}

/** moment ids of the clips in the reel, in output order (review list) */
export async function reelIds(page: Page): Promise<string[]> {
  return page
    .getByTestId('clip-item')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-moment-id') ?? ''))
}

export async function suggestionIds(page: Page): Promise<string[]> {
  return page
    .getByTestId('suggestion-item')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-moment-id') ?? ''))
}

export function clipItem(page: Page, momentId: string): Locator {
  return page.locator(`[data-testid="clip-item"][data-moment-id="${momentId}"]`)
}

/** the length meter's value: reel length in seconds (crossfades included) */
export async function totalSec(page: Page): Promise<number> {
  return Number(await page.getByTestId('total-duration').getAttribute('data-total-sec'))
}

export async function expectTotal(page: Page, seconds: number): Promise<void> {
  await expect(page.getByTestId('total-duration')).toHaveAttribute(
    'data-total-sec',
    seconds.toFixed(1)
  )
}

export async function projectState(hc: HcApp, id: string): Promise<Project> {
  return hc.api('openProject', id)
}

export function reelOf(project: Project): Moment[] {
  return project.moments.filter((moment) => moment.selected)
}

/** effective reel length like the app computes it (crossfades overlap neighbouring clips) */
export function reelLength(project: Project): number {
  const reel = reelOf(project)
  if (reel.length === 0) return 0
  const overlap = project.exportSettings.transition === 'crossfade' ? EXPORT_FIXED.crossfadeSec : 0
  const sum = reel.reduce((acc, moment) => acc + (moment.end - moment.start), 0)
  return sum - overlap * (reel.length - 1)
}

export function toast(page: Page, text: string | RegExp): Locator {
  return page.getByTestId('toast').filter({ hasText: text })
}

/** a toast with this text was shown (it may have disappeared again) */
export async function expectToast(
  hc: HcApp,
  text: string | RegExp,
  options: { level?: string; timeout?: number } = {}
): Promise<void> {
  const matches = (message: string): boolean =>
    typeof text === 'string' ? message.includes(text) : text.test(message)
  await expect
    .poll(
      async () =>
        (await hc.toasts()).some(
          (shown) =>
            matches(shown.text) && (options.level === undefined || shown.level === options.level)
        ),
      { message: `toast ${String(text)}`, timeout: options.timeout ?? 20_000 }
    )
    .toBe(true)
}

/**
 * Edit: trims every clip of the reel to its first second (through main, like the trim keys).
 * Every export is 4K: three clips of 1 s keep it light on memory, disk and time.
 */
export async function shortenReel(hc: HcApp, id: string): Promise<Project> {
  let project = await projectState(hc, id)
  for (const { id: momentId, start } of reelOf(project)) {
    project = await hc.api('mutateProject', id, {
      type: 'updateMomentTimes',
      momentId,
      start,
      end: start + 1
    })
  }
  // the renderer has the trimmed reel too (an export it starts earlier would count as outdated)
  await expectTotal(hc.page, reelLength(project))
  return project
}

/** file names of the reel clips' videos, in output order */
export function reelSources(project: Project): string[] {
  return reelOf(project).map(
    (moment) => project.videos.find((video) => video.id === moment.videoId)?.fileName ?? '?'
  )
}

/** clip lengths of the reel in output order */
export function reelDurations(project: Project): number[] {
  return reelOf(project).map((moment) => moment.end - moment.start)
}

/** Export step: "Create highlight video" and wait for "Done!"; returns the output path */
export async function exportAndWait(hc: HcApp, id: string): Promise<string> {
  const page = hc.page
  const exportsBefore = (await projectState(hc, id)).exports.length
  await page.getByTestId('start-export').click()
  await expect(page.getByTestId('export-done')).toBeVisible({ timeout: TIMEOUTS.export })
  const project = await projectState(hc, id)
  expect(project.exports).toHaveLength(exportsBefore + 1)
  return project.exports[project.exports.length - 1].path
}
