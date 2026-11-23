// Flow 3 – export variants: crossfade + blurred background, a project file of an older version
// (16:9 into a folder of its own), and cancelling mid-way. Every export is 4K (EXPORT_FIXED), so
// the reels are three clips of 1 s.

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { EXPORT_FIXED } from '../src/shared/presets'
import type { ExportRecord } from '../src/shared/types'
import { expect, test } from './fixtures'
import type { HcApp } from './support/app'
import {
  analysedProject,
  expectTotal,
  exportAndWait,
  goToStep,
  projectState,
  reelDurations,
  reelLength,
  reelOf,
  reelSources,
  screen,
  shortenReel
} from './support/flows'
import { probeExport, reelTones, TEST_TONES, tonesByFileName } from './support/media'
import { ffmpegProcesses } from './support/processes'

async function chooseOptions(hc: HcApp, testIds: string[]): Promise<void> {
  for (const testId of testIds) {
    const option = hc.page.getByTestId(testId)
    await option.click()
    await expect(option).toHaveAttribute('aria-checked', 'true')
  }
}

test.describe('Flow 3: export variants', () => {
  test('crossfade with blurred background', async ({ hc, videos }) => {
    const { page } = hc
    // landscape + portrait sources: the blurred background fills a 9:16 frame
    const id = await analysedProject(hc, [
      videos.portrait.path,
      videos.landscapeSilent.path,
      videos.rotated.path
    ])
    await shortenReel(hc, id)
    await page.getByTestId('go-export').click()
    await expect(screen(page, 'export')).toBeVisible()
    await chooseOptions(hc, ['aspect-9:16', 'fit-blur', 'transition-crossfade'])

    // the review's length meter subtracts the overlaps
    const project = await projectState(hc, id)
    expect(project.exportSettings).toMatchObject({ fit: 'blur', transition: 'crossfade' })
    const expected = reelLength(project)
    const clips = reelOf(project).length
    expect(clips).toBe(3)
    await goToStep(hc, 'review')
    await expectTotal(page, expected)
    await goToStep(hc, 'export')

    const output = await exportAndWait(hc, id)
    const facts = await probeExport(output)
    test.info().annotations.push({
      type: 'export',
      description: `crossfade/blur: ${facts.durationSec.toFixed(3)} s (reel ${expected.toFixed(2)} s)`
    })
    expect(facts.video).toMatchObject({ codec_name: 'h264', width: 2160, height: 3840 })
    expect(facts.audio, 'audio from the clips with sound').toBeTruthy()
    expect(Math.abs(facts.durationSec - expected)).toBeLessThanOrEqual(0.3)

    // every clip in reel order – the landscape clip without sound is filled with silence
    const tones = tonesByFileName(videos)
    const expectedTones = reelSources(project).map((file) => tones.get(file))
    expect(expectedTones).toContain(TEST_TONES.landscapeSilent)
    expect(await reelTones(output, reelDurations(project), EXPORT_FIXED.crossfadeSec)).toEqual(
      expectedTones
    )
  })

  test('a project saved by an older version opens and exports with the fixed set', async ({
    hc,
    videos
  }) => {
    const id = await analysedProject(hc, [
      videos.portrait.path,
      videos.portraitHevc.path,
      videos.rotated.path
    ])
    await shortenReel(hc, id)
    await hc.page.getByTestId('go-export').click()
    await expect(screen(hc.page, 'export')).toBeVisible()
    await chooseOptions(hc, ['aspect-16:9', 'fit-crop', 'transition-cut'])
    // into a folder of its own (stubbed folder dialog) that does not exist yet; its name has a
    // space and an umlaut
    const folder = join(hc.root, 'Exports for Jan – ü')
    await hc.pickDirectory(folder)
    await hc.page.getByTestId('choose-output-dir').click()
    await expect(hc.page.getByTestId('reset-output-dir')).toBeVisible()
    await hc.close()

    // the project file as the older version wrote it: resolution, frame rate, codec, quality,
    // fades, loudness and crossfade length were choices then, and it has an export in its history
    const file = join(hc.userDataDir, 'projects', id, 'project.json')
    const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    const oldExport: ExportRecord = {
      id: 'old-export',
      path: join(folder, 'Summer party – Highlights 2026-08-01 21.30.mp4'),
      createdAt: '2026-08-01T19:30:00.000Z',
      durationSec: 12.5,
      clipCount: 3,
      sizeBytes: 9_876_543
    }
    saved.exportSettings = {
      aspect: '16:9',
      fit: 'crop',
      resolution: '720p',
      fps: 60,
      transition: 'cut',
      transitionSec: 1,
      fadeInOut: false,
      normalizeAudio: false,
      codec: 'hevc',
      quality: 'standard',
      outputDir: folder
    }
    saved.exports = [oldExport]
    await writeFile(file, JSON.stringify(saved))

    await hc.launch()
    const { page } = hc
    await page
      .getByTestId('project-card')
      .getByRole('button', { name: /^Open / })
      .click()
    await expect(screen(page, 'review')).toBeVisible()
    await page.getByTestId('go-export').click()
    await expect(screen(page, 'export')).toBeVisible()
    await expect(page.getByTestId('aspect-16:9')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('export-record')).toContainText(basename(oldExport.path))
    const project = await projectState(hc, id)
    expect(project.exportSettings).toEqual({
      aspect: '16:9',
      fit: 'crop',
      transition: 'cut',
      outputDir: folder
    })
    expect(project.exports).toEqual([oldExport])
    const expected = reelLength(project)

    const output = await exportAndWait(hc, id)
    expect(dirname(output)).toBe(folder)
    expect(await readdir(folder)).toEqual([basename(output)])
    expect((await projectState(hc, id)).exports[0]).toEqual(oldExport)
    const facts = await probeExport(output)
    test.info().annotations.push({
      type: 'export',
      description: `old project: ${facts.video.codec_name} ${facts.video.width}×${facts.video.height} ${facts.durationSec.toFixed(3)} s (reel ${expected.toFixed(2)} s)`
    })
    // 4K H.264 at 30 fps, whatever the file asked for
    expect(facts.video).toMatchObject({
      codec_name: 'h264',
      width: 3840,
      height: 2160,
      avg_frame_rate: '30/1'
    })
    expect(facts.audio).toBeTruthy()
    expect(Math.abs(facts.durationSec - expected)).toBeLessThanOrEqual(0.3)
    const tones = tonesByFileName(videos)
    expect(await reelTones(output, reelDurations(project), 0)).toEqual(
      reelSources(project).map((file) => tones.get(file))
    )
  })

  test('cancelling an export leaves no file behind and the next export works', async ({
    hc,
    videos
  }) => {
    const { page } = hc
    const id = await analysedProject(hc, [
      videos.portrait.path,
      videos.portraitHevc.path,
      videos.rotated.path
    ])
    await shortenReel(hc, id)
    await page.getByTestId('go-export').click()
    await expect(screen(page, 'export')).toBeVisible()
    // 4K renders long enough to cancel in the middle
    await page.getByTestId('start-export').click()
    await expect(
      page.locator('[data-testid="export-progress"][data-phase="rendering"]')
    ).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('cancel-export').click()
    await expect(page.getByTestId('export-progress')).toHaveCount(0)
    await expect(page.getByText('Export cancelled.')).toBeVisible()
    await expect(page.getByTestId('start-export')).toHaveText('Create highlight video')

    // nothing in the export folder (not even a hidden .part file), no render scratch folder,
    // no ffmpeg still running
    await expect.poll(() => ffmpegProcesses(hc.root)).toEqual([])
    expect(await readdir(hc.outputDir)).toEqual([])
    const tmp = join(hc.userDataDir, 'projects', id, 'tmp')
    await expect.poll(() => readdir(tmp).catch(() => 'gone')).toBe('gone')
    expect((await projectState(hc, id)).exports).toEqual([])

    // the project is not stuck: the next export runs through
    const output = await exportAndWait(hc, id)
    const facts = await probeExport(output)
    expect(facts.video).toMatchObject({ width: 2160, height: 3840 })
    expect(await readdir(hc.outputDir)).toHaveLength(1)
  })
})
