// Flow 2 – happy path: new project → 3 videos → Prompt → fake analysis → Edit step → 9:16 export,
// verified with ffprobe.

import { readdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { DEFAULT_BRIEF } from '../src/shared/presets'
import { expect, test } from './fixtures'
import {
  addVideos,
  clipItem,
  createProject,
  expectToast,
  expectTotal,
  goToStep,
  projectState,
  reelDurations,
  reelIds,
  reelOf,
  screen,
  shortenReel,
  startAnalysis,
  totalSec,
  waitForAnalysis,
  waitForPrepared
} from './support/flows'
import { FFMPEG, TIMEOUTS } from './support/env'
import { copyVideo, probeExport, reelTones, TEST_TONES } from './support/media'

/** "2026-11-01 18.42" from "<name> – Highlights 2026-11-01 18.42 (2).mp4" */
function exportStamp(path: string): string {
  return /Highlights (.+?)(?: \(\d+\))?\.mp4$/.exec(basename(path))?.[1] ?? ''
}

test.describe('Flow 2: happy path', () => {
  test('three videos → analysis → review edits → 9:16 crop/cut export matches the reel', async ({
    hc,
    videos
  }) => {
    const { page } = hc
    // a file name with spaces, umlauts and a dash (hc-media URLs, ffmpeg arguments)
    const umlautCopy = await copyVideo(
      videos.rotated.path,
      hc.videoDir,
      'Nacht am Fluss – Grüße & Tänze.mp4'
    )

    // new project, renamed with characters that are not allowed in file names
    const id = await createProject(hc)
    await page.getByTestId('project-name').click()
    await page.getByRole('textbox', { name: 'Project name' }).fill('Sommerfest: Grüße/Tänze')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('project-name')).toHaveText('Sommerfest: Grüße/Tänze')

    // three videos; cards sorted by recording time, previews finish in the background
    await addVideos(hc, [umlautCopy, videos.portraitHevc.path, videos.portrait.path])
    await expectToast(hc, '3 videos added', { level: 'success' })
    await expect(page.getByTestId('video-card').locator('.video-card__name')).toHaveText([
      videos.portrait.fileName,
      videos.portraitHevc.fileName,
      'Nacht am Fluss – Grüße & Tänze.mp4'
    ])
    await waitForPrepared(hc, 3)
    // the app cuts with the ffmpeg these helpers use: the repo's own (vendor/ffmpeg), not Homebrew's
    expect((await hc.api('getAppInfo')).ffmpeg.ffmpegPath).toBe(FFMPEG)
    const prepared = await projectState(hc, id)
    for (const video of prepared.videos) {
      expect(video.proxyPath, `${video.fileName} has a proxy`).toBeTruthy()
      expect(video.spriteInfo, `${video.fileName} has a filmstrip`).toBeTruthy()
    }

    // Prompt: the default prompt + 30 s target → analysis
    await page.getByTestId('next-step').click()
    await expect(page.getByTestId('brief-prompt')).toHaveValue(DEFAULT_BRIEF.prompt)
    await startAnalysis(hc, { target: 30 })
    await waitForAnalysis(hc, { done: 3 })
    const summary = page.getByTestId('analysis-summary')
    await expect(summary).toContainText('Done! 3 moments found in 3 videos')
    await expectToast(hc, 'Analysis done: 3 moments from 3 videos', { level: 'success' })
    // every moment is in the reel (3 × 5 s fit into 30 s)
    await expect(summary).toContainText(
      '3 of them are already selected to match the target length of 30 s'
    )
    const analysed = await projectState(hc, id)
    expect(analysed.brief).toEqual({ prompt: DEFAULT_BRIEF.prompt, targetDurationSec: 30 })
    expect(analysed.reelEdited).toBe(false)

    // Edit: the automatic reel in chronological order
    await page.getByTestId('go-review').click()
    await expect(screen(page, 'review')).toBeVisible()
    const [a, b, c] = reelOf(analysed).map((m) => m.id)
    await expect.poll(() => reelIds(page)).toEqual([a, b, c])
    const fullLength = reelOf(analysed).reduce((sum, m) => sum + m.end - m.start, 0)
    await expect(page.getByTestId('total-duration')).toBeVisible()
    await expectTotal(page, fullLength)

    // toggle: take the last clip out, then back in from "More suggestions"
    await clipItem(page, c).getByTestId('clip-toggle').click()
    await expect(page.getByTestId('clip-item')).toHaveCount(2)
    await page.getByTestId('tab-suggestions').click()
    const suggestion = page.locator(`[data-testid="suggestion-item"][data-moment-id="${c}"]`)
    await expect(suggestion).toBeVisible()
    await suggestion.getByTestId('clip-toggle').click()
    await page.getByTestId('tab-clips').click()
    await expect.poll(() => reelIds(page)).toEqual([a, b, c])

    // trim the first clip with the nudge buttons, then back to Gemini's times
    await clipItem(page, a).locator('.clip__main').click()
    await expect(clipItem(page, a)).toHaveClass(/is-active/)
    const original = analysed.moments.find((m) => m.id === a)!
    await page.getByTestId('nudge-in-plus').click()
    await expectTotal(page, fullLength - 0.5)
    await page.getByTestId('nudge-out-minus').click()
    await expectTotal(page, fullLength - 1)
    const trimmed = (await projectState(hc, id)).moments.find((m) => m.id === a)!
    expect(trimmed.start).toBeCloseTo(original.start + 0.5, 2)
    expect(trimmed.end).toBeCloseTo(original.end - 0.5, 2)
    await page.getByTestId('reset-times').click()
    await expectTotal(page, fullLength)
    await expect(page.getByTestId('reset-times')).toBeDisabled()
    const reset = (await projectState(hc, id)).moments.find((m) => m.id === a)!
    expect([reset.start, reset.end]).toEqual([original.start, original.end])

    // reorder with the arrow buttons: [a, b, c] → [b, a, c] → [b, c, a]
    await clipItem(page, a).getByTestId('clip-move-down').click()
    await expect.poll(() => reelIds(page)).toEqual([b, a, c])
    await clipItem(page, c).getByTestId('clip-move-up').click()
    await expect.poll(() => reelIds(page)).toEqual([b, c, a])
    const edited = await projectState(hc, id)
    expect(reelOf(edited).map((m) => m.id)).toEqual([b, c, a])
    expect(edited.reelEdited).toBe(true)
    expect(await totalSec(page)).toBeCloseTo(fullLength, 1)

    // every export is 4K: clips of 1 s keep it light on memory, disk and time
    const short = await shortenReel(hc, id)
    const reelSec = 3

    // Export: 9:16, crop, hard cut
    await page.getByTestId('go-export').click()
    await expect(screen(page, 'export')).toBeVisible()
    for (const choice of ['aspect-9:16', 'fit-crop', 'transition-cut']) {
      await page.getByTestId(choice).click()
      await expect(page.getByTestId(choice)).toHaveAttribute('aria-checked', 'true')
    }
    await page.getByTestId('start-export').click()
    await expect(page.getByTestId('export-progress')).toBeVisible()
    await expect(page.getByTestId('export-done')).toBeVisible({ timeout: TIMEOUTS.export })
    await expectToast(hc, 'Done! Your highlight video is saved.', { level: 'success' })

    // the file: in HC_OUTPUT_DIR, sanitised name, no temp files next to it
    const done = await projectState(hc, id)
    expect(done.exports).toHaveLength(1)
    const output = done.exports[0].path
    expect(dirname(output)).toBe(hc.outputDir)
    expect(basename(output)).toMatch(
      /^Sommerfest- Grüße-Tänze – Highlights \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.mp4$/
    )
    expect(await readdir(hc.outputDir)).toEqual([basename(output)])
    await expect(page.getByTestId('export-done')).toContainText(basename(output))

    // ffprobe: 4K (2160×3840) H.264 with audio, as long as the reel
    const facts = await probeExport(output)
    expect(facts.video).toMatchObject({ codec_name: 'h264', width: 2160, height: 3840 })
    expect(facts.audio, 'the reel has an audio stream').toBeTruthy()
    expect(Math.abs(facts.durationSec - reelSec)).toBeLessThanOrEqual(0.3)
    expect(Math.abs(done.exports[0].durationSec - facts.durationSec)).toBeLessThan(0.05)
    expect(done.exports[0].clipCount).toBe(3)

    // the clips play in the edited order [b, c, a]: every source video has its own tone
    const toneOf = new Map([
      [videos.portrait.fileName, TEST_TONES.portrait],
      [videos.portraitHevc.fileName, TEST_TONES.portraitHevc],
      ['Nacht am Fluss – Grüße & Tänze.mp4', TEST_TONES.rotated]
    ])
    const sourceOf = (videoId: string): string =>
      edited.videos.find((video) => video.id === videoId)!.fileName
    const expectedTones = reelOf(edited).map((m) => toneOf.get(sourceOf(m.videoId)))
    expect(expectedTones).toEqual([
      TEST_TONES.portraitHevc,
      TEST_TONES.rotated,
      TEST_TONES.portrait
    ])
    expect(await reelTones(output, reelDurations(short), 0)).toEqual(expectedTones)

    // "Play" and "Show in Finder" go to the (stubbed) shell with the output path
    await page.getByTestId('open-output').click()
    await page.getByTestId('show-in-finder').click()
    await expect
      .poll(() => hc.shellCalls())
      .toEqual([
        { method: 'openPath', arg: output },
        { method: 'showItemInFolder', arg: output }
      ])

    // exporting again never overwrites: a second file, the first one moves to the history
    await page.getByTestId('start-export').click()
    await expect
      .poll(async () => (await projectState(hc, id)).exports.length, { timeout: TIMEOUTS.export })
      .toBe(2)
    const second = (await projectState(hc, id)).exports[1].path
    expect(second).not.toBe(output)
    if (exportStamp(second) === exportStamp(output)) {
      expect(basename(second)).toMatch(/ \(2\)\.mp4$/)
    }
    await expect(page.getByTestId('export-done')).toContainText(basename(second))
    await expect(page.getByTestId('export-record')).toHaveCount(1)
    await expect(page.getByTestId('export-record')).toContainText(basename(output))
    expect((await readdir(hc.outputDir)).sort()).toEqual(
      [basename(output), basename(second)].sort()
    )

    // a changed reel makes the finished export outdated: the export step offers a new one
    await goToStep(hc, 'review')
    await clipItem(page, a).getByTestId('clip-toggle').click()
    await expect.poll(() => reelIds(page)).toEqual([b, c])
    await goToStep(hc, 'export')
    await expect(page.getByTestId('export-done')).toHaveCount(0)
    await expect(page.getByTestId('start-export')).toHaveText('Create highlight video')
    await expect(page.getByTestId('export-record')).toHaveCount(2)
  })

  // autoselect-broadcast-lag: main selects the reel in the same project update as the last video's
  // result, so the renderer never shows a finished run without its reel ("In the Edit step you
  // choose …" and an empty review for up to 200 ms before)
  test('a finished analysis shows the automatic reel right away', async ({ hc, videos }) => {
    const { page } = hc
    const id = await createProject(hc)
    await addVideos(hc, [videos.portrait.path, videos.portraitHevc.path, videos.rotated.path])
    await waitForPrepared(hc, 3)
    await page.getByTestId('next-step').click()
    await startAnalysis(hc)
    // every text the summary card shows from now on
    await page.evaluate(() => {
      const seen: string[] = []
      ;(window as unknown as { __summaries: string[] }).__summaries = seen
      const note = (): void => {
        const text = document.querySelector('[data-testid="analysis-summary"]')?.textContent ?? ''
        if (seen[seen.length - 1] !== text) seen.push(text)
      }
      new MutationObserver(note).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true
      })
    })
    await waitForAnalysis(hc, { done: 3 })
    expect(reelOf(await projectState(hc, id))).toHaveLength(3)
    await expect(page.getByTestId('analysis-summary')).toContainText('3 of them are already')
    const shown = await page.evaluate(
      () => (window as unknown as { __summaries: string[] }).__summaries
    )
    expect(shown.filter((text) => text.includes('In the Edit step you choose'))).toEqual([])
  })
})
