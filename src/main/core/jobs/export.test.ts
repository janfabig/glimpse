import { estimateExportBytes } from '@shared/export-size'
import { parseIpcError, TOAST_KEYS } from '@shared/ipc'
import { DEFAULT_EXPORT_SETTINGS, EXPORT_FIXED } from '@shared/presets'
import type { Project } from '@shared/types'
import { mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MediaError, type RenderProgress } from '../../contracts'
import { MESSAGES as MEDIA_MESSAGES } from '../../media/errors'
import { DISK_FULL_MESSAGE } from '../errors'
import { pathExists } from '../fsx'
import { FAKE_FFMPEG_MISSING } from '../testing/fakeMedia'
import { makeMoment } from '../testing/fixtures'
import { createHarness, type Harness } from '../testing/harness'
import { eventually } from '../testing/helpers'
import { DISK_RESERVE_BYTES } from './diskSpace'
import { mapRenderProgress } from './export'
import { JOB_MESSAGES } from './messages'

let h: Harness

beforeEach(async () => {
  h = await createHarness()
})

afterEach(async () => {
  await h.dispose()
})

const EXPECTED_NAME = 'Festival – Highlights 2026-07-12 21.14.mp4'

/** prepared project with moments; the selected ones in output order: b1, a1 */
async function exportProject(): Promise<{ project: Project; files: string[] }> {
  const { project, videoIds, files } = await h.preparedProject(['a.mp4', 'b.mp4'])
  const [a, b] = videoIds
  const next = h.store.update(project.id, (draft) => {
    draft.moments = [
      makeMoment({ id: 'b1', videoId: b, start: 30, end: 34.5, selected: true }),
      makeMoment({ id: 'a0', videoId: a, start: 1, end: 3 }),
      makeMoment({ id: 'a1', videoId: a, start: 10, end: 16, selected: true })
    ]
  })
  return { project: next, files }
}

describe('export', () => {
  it('renders the selected moments from the originals, records the export and cleans up', async () => {
    const { project, files } = await exportProject()
    const { exportId } = await h.jobs.startExport(project.id)
    expect(h.progress[0]).toEqual({
      projectId: project.id,
      exportId,
      phase: 'preparing',
      progress: 0,
      clipCount: 2,
      message: JOB_MESSAGES.exportPreparing
    })
    await h.jobs.whenIdle()

    const job = h.media.calls.render[0]
    expect(job.clips).toEqual([
      {
        sourcePath: files[1],
        start: 30,
        end: 34.5,
        hasAudio: true,
        sourceWidth: 1440,
        sourceHeight: 1920
      },
      {
        sourcePath: files[0],
        start: 10,
        end: 16,
        hasAudio: true,
        sourceWidth: 1440,
        sourceHeight: 1920
      }
    ])
    expect(job.settings).toEqual(DEFAULT_EXPORT_SETTINGS)
    // 4K at 30 fps, whatever the project says
    expect(job.frame).toEqual({ shortSide: 2160, fps: 30 })
    expect(job.outputPath).toBe(join(h.outputDir, EXPECTED_NAME))
    expect(job.workDir).toBe(h.paths.exportWorkDir(project.id, exportId))
    expect(await pathExists(job.workDir)).toBe(false)
    expect(await pathExists(h.paths.projectTmpDir(project.id))).toBe(false)

    const phases = h.progress.map((p) => p.phase)
    expect(phases[0]).toBe('preparing')
    expect(phases).toContain('rendering')
    expect(phases.slice(-3)).toEqual(['joining', 'finishing', 'done'])
    const values = h.progress.map((p) => p.progress)
    expect(values).toEqual([...values].sort((x, y) => x - y))
    expect(h.progress.at(-1)).toMatchObject({
      phase: 'done',
      progress: 1,
      outputPath: job.outputPath,
      exportId
    })
    expect(h.progress.find((p) => p.phase === 'rendering')).toMatchObject({
      currentClip: 1,
      clipCount: 2,
      message: 'Rendering clip 1 of 2…'
    })

    expect(h.store.get(project.id).exports).toEqual([
      {
        id: exportId,
        path: job.outputPath,
        createdAt: expect.any(String),
        durationSec: 10.5,
        clipCount: 2,
        sizeBytes: 15
      }
    ])
    expect(h.toasts).toEqual([
      { level: 'success', message: JOB_MESSAGES.exportSaved, projectId: project.id }
    ])
  })

  it('never overwrites an existing file', async () => {
    const { project } = await exportProject()
    await mkdir(h.outputDir, { recursive: true })
    await writeFile(join(h.outputDir, EXPECTED_NAME), 'older export')
    await h.jobs.startExport(project.id)
    await h.jobs.whenIdle()
    await h.jobs.startExport(project.id)
    await h.jobs.whenIdle()
    expect(h.media.calls.render.map((job) => job.outputPath)).toEqual([
      join(h.outputDir, 'Festival – Highlights 2026-07-12 21.14 (2).mp4'),
      join(h.outputDir, 'Festival – Highlights 2026-07-12 21.14 (3).mp4')
    ])
  })

  it('gives running exports whose names differ only in case or Unicode form their own files', async () => {
    const gate = h.media.hold('render')
    const ids: string[] = []
    for (const name of ['Grünfest', 'GRÜNFEST', 'Gru\u0308nfest']) {
      const { project } = await exportProject()
      h.store.update(project.id, (draft) => void (draft.name = name))
      ids.push(project.id)
    }
    // all three render at the same time: none of the files exists yet
    for (const id of ids) await h.jobs.startExport(id)
    await eventually(() => expect(gate.waiting).toBe(3))
    gate.release()
    await h.jobs.whenIdle()
    expect(h.media.calls.render.map((job) => basename(job.outputPath).normalize('NFC'))).toEqual([
      'Grünfest – Highlights 2026-07-12 21.14.mp4',
      'GRÜNFEST – Highlights 2026-07-12 21.14 (2).mp4',
      'Grünfest – Highlights 2026-07-12 21.14 (3).mp4'
    ])
  })

  it('uses the project output folder when one is set and sanitises the name', async () => {
    const { project } = await exportProject()
    const custom = join(h.temp.path, 'Desktop', 'Reels')
    h.store.update(project.id, (draft) => {
      draft.name = 'Rock: am/Ring'
      draft.exportSettings.outputDir = custom
    })
    await h.jobs.startExport(project.id)
    await h.jobs.whenIdle()
    expect(await readdir(custom)).toEqual(['Rock- am-Ring – Highlights 2026-07-12 21.14.mp4'])
  })

  it('cancels a running export without leaving files behind', async () => {
    const { project } = await exportProject()
    const gate = h.media.hold('render')
    const { exportId } = await h.jobs.startExport(project.id)
    await gate.reached
    await expect(h.jobs.startExport(project.id)).rejects.toThrow(/busy/)
    h.jobs.cancelExport(project.id)
    await h.jobs.whenIdle()
    expect(h.progress.at(-1)).toMatchObject({
      exportId,
      phase: 'cancelled',
      message: JOB_MESSAGES.exportCancelled
    })
    expect(h.store.get(project.id).exports).toEqual([])
    expect(await pathExists(h.paths.exportWorkDir(project.id, exportId))).toBe(false)
    expect(await pathExists(join(h.outputDir, EXPECTED_NAME))).toBe(false)
    expect(h.toasts).toEqual([])
    // the slot is free again
    gate.release()
    await h.jobs.startExport(project.id)
    await h.jobs.whenIdle()
    expect(h.progress.at(-1)?.phase).toBe('done')
  })

  it('skips ffmpeg when cancelled while the job is being built', async () => {
    const { project } = await exportProject()
    const gate = h.media.hold('status')
    const starting = h.jobs.startExport(project.id)
    await gate.reached
    h.jobs.cancelExport(project.id)
    gate.release()
    const { exportId } = await starting
    await h.jobs.whenIdle()
    expect(h.media.calls.render).toEqual([])
    expect(h.progress.at(-1)).toMatchObject({ exportId, phase: 'cancelled' })
    expect(await pathExists(h.paths.projectTmpDir(project.id))).toBe(false)
  })

  it('never recreates the folder of a project deleted while its export is being built', async () => {
    const { project } = await exportProject()
    const gate = h.media.hold('status')
    const starting = h.jobs.startExport(project.id)
    await gate.reached
    const deleting = h.jobs.deleteProject(project.id)
    gate.release()
    await expect(starting).rejects.toThrow(/not-found/)
    await deleting
    expect(h.media.calls.render).toEqual([])
    expect(await pathExists(h.paths.projectDir(project.id))).toBe(false)
    expect(h.log.entries.map((e) => e.message)).not.toContain('jobs still running while deleting')
  })

  it('does not start an export that does not fit on the disk', async () => {
    const { project } = await exportProject()
    // 10.5 s at 2160×3840 ≈ 63 MiB, in the work dir and in the output folder, plus the reserve
    h.disk.free = 150 * 1024 * 1024
    await expect(h.jobs.startExport(project.id)).rejects.toThrow(DISK_FULL_MESSAGE)
    expect(h.media.calls.render).toEqual([])
    expect(await pathExists(h.paths.projectTmpDir(project.id))).toBe(false)
    expect(h.progress).toEqual([])

    // an output folder on another volume only has to hold the video itself
    h.disk.volumes = (path) => (path.startsWith(h.outputDir) ? 'external' : 'internal')
    await h.jobs.startExport(project.id)
    await h.jobs.whenIdle()
    expect(h.media.calls.render.map((job) => job.outputPath)).toEqual([
      join(h.outputDir, EXPECTED_NAME)
    ])
  })

  it('reserves room for the work files of a crossfade: the clips and the longest segment', async () => {
    const { project } = await exportProject()
    // 4.5 s + 6 s with one transition; the 6 s clip is the longest segment
    const lengthSec = 10.5 - EXPORT_FIXED.crossfadeSec
    const estimate = estimateExportBytes('9:16', { width: 1440, height: 1920 }, lengthSec)
    // hard cuts need 2 × the estimate (video + work files), a crossfade about 3.1 × (video,
    // 1.5 × for the near-lossless clips, 6 / 10.1 for the segment)
    h.disk.free = Math.ceil(2.8 * estimate) + DISK_RESERVE_BYTES
    h.store.update(project.id, (draft) => void (draft.exportSettings.transition = 'crossfade'))
    await expect(h.jobs.startExport(project.id)).rejects.toThrow(DISK_FULL_MESSAGE)
    expect(h.media.calls.render).toEqual([])

    h.store.update(project.id, (draft) => void (draft.exportSettings.transition = 'cut'))
    await h.jobs.startExport(project.id)
    await h.jobs.whenIdle()
    expect(h.media.calls.render).toHaveLength(1)
  })

  it('names a full export folder on another drive instead of blaming the Mac', async () => {
    const { project } = await exportProject()
    // the export folder is on an external SSD with 10 MB left; the Mac has plenty of space
    h.disk.volumes = (path) => (path.startsWith(h.outputDir) ? 'external-ssd' : 'macintosh-hd')
    h.disk.freeBytes = async (path) => (path.startsWith(h.outputDir) ? 10 * 1024 * 1024 : 500e9)
    const err: unknown = await h.jobs.startExport(project.id).catch((e: unknown) => e)
    expect(parseIpcError(err)).toEqual({
      code: 'internal',
      message:
        `There is not enough free space in the export folder “${h.outputDir}”. Free up space ` +
        'there or choose another export folder when you export.'
    })
    expect(h.media.calls.render).toEqual([])

    // the other way round – the Mac (work files) is full: the Mac's text
    h.disk.freeBytes = async (path) => (path.startsWith(h.outputDir) ? 500e9 : 10 * 1024 * 1024)
    await expect(h.jobs.startExport(project.id)).rejects.toThrow(DISK_FULL_MESSAGE)
  })

  it('removes the half file of a killed export from the export folder before it checks the space', async () => {
    const { project } = await exportProject()
    await mkdir(h.outputDir, { recursive: true })
    // the join of an export that died with the app or the Mac: hidden, gigabytes, never cleaned up
    const half = join(h.outputDir, '.Festival – Highlights 2026-07-11 20.02.3fa2c1d0.part.mp4')
    await writeFile(half, 'half')
    const before = new Date(Date.now() - 5 * 60_000)
    await utimes(half, before, before)
    // the folder is full as long as that file is there
    h.disk.freeBytes = async () => ((await pathExists(half)) ? 0 : 500e9)
    await h.jobs.startExport(project.id)
    await h.jobs.whenIdle()
    expect(await readdir(h.outputDir)).toEqual([EXPECTED_NAME])
  })

  it('passes media’s text about a full export folder on, not the Mac’s', async () => {
    const { project } = await exportProject()
    const folderFull = MEDIA_MESSAGES.outputFolderFull(h.outputDir)
    h.media.renderError = new MediaError(
      'ffmpeg',
      folderFull,
      'Error writing trailer: No space left on device'
    )
    await h.jobs.startExport(project.id)
    await h.jobs.whenIdle()
    expect(h.progress.at(-1)).toMatchObject({ phase: 'error', error: folderFull })
    // and a full disk media did not attribute to the export folder stays the Mac's
    h.media.renderError = new MediaError(
      'ffmpeg',
      MEDIA_MESSAGES.diskFull,
      'No space left on device'
    )
    await h.jobs.startExport(project.id)
    await h.jobs.whenIdle()
    expect(h.progress.at(-1)).toMatchObject({ phase: 'error', error: DISK_FULL_MESSAGE })
  })

  it('turns a file-system error at the start into a user-facing error and frees the slot', async () => {
    const { project } = await exportProject()
    // something blocks the scratch folder of the export
    await writeFile(h.paths.projectTmpDir(project.id), 'not a folder')
    const err: unknown = await h.jobs.startExport(project.id).catch((e: unknown) => e)
    expect(parseIpcError(err)).toEqual({
      code: 'internal',
      message: JOB_MESSAGES.exportPrepareFailed
    })
    expect(h.media.calls.render).toEqual([])
    await rm(h.paths.projectTmpDir(project.id))
    await h.jobs.startExport(project.id)
    await h.jobs.whenIdle()
    // the name reserved by the failed start was released again
    expect(h.media.calls.render.map((job) => job.outputPath)).toEqual([
      join(h.outputDir, EXPECTED_NAME)
    ])
  })

  it('reports render errors with the media module’s message', async () => {
    const { project } = await exportProject()
    h.media.renderError = new MediaError('ffmpeg', 'The clips could not be joined.', 'stderr tail')
    const { exportId } = await h.jobs.startExport(project.id)
    await h.jobs.whenIdle()
    expect(h.progress.at(-1)).toMatchObject({
      exportId,
      phase: 'error',
      error: 'The clips could not be joined.'
    })
    expect(h.toasts).toEqual([
      {
        level: 'error',
        message: JOB_MESSAGES.exportFailedToast('The clips could not be joined.'),
        // stays until closed, and leaves with this project's screens
        projectId: project.id,
        sticky: true,
        key: TOAST_KEYS.exportFailed(project.id)
      }
    ])
    expect(await pathExists(h.paths.exportWorkDir(project.id, exportId))).toBe(false)
    expect(h.log.text()).toContain('stderr tail')
  })
})

describe('export validation', () => {
  it('needs at least one selected clip', async () => {
    const { project } = await exportProject()
    h.store.update(project.id, (draft) => draft.moments.forEach((m) => (m.selected = false)))
    await expect(h.jobs.startExport(project.id)).rejects.toThrow(/nothing-selected/)
  })

  it('needs ffmpeg', async () => {
    const { project } = await exportProject()
    h.media.statusResult = FAKE_FFMPEG_MISSING
    await expect(h.jobs.startExport(project.id)).rejects.toThrow(/no-ffmpeg/)
    h.media.statusResult = { ...FAKE_FFMPEG_MISSING }
  })

  it('names a missing original file', async () => {
    const { project, files } = await exportProject()
    await rm(files[1])
    await expect(h.jobs.startExport(project.id)).rejects.toThrow(
      JOB_MESSAGES.missingOriginal('b.mp4')
    )
    expect(h.media.calls.render).toEqual([])
    // the failed start does not block the next one
    await writeFile(files[1], 'video data of b.mp4')
    await h.jobs.startExport(project.id)
    await h.jobs.whenIdle()
    expect(h.media.calls.render).toHaveLength(1)
  })

  it('stops when the original at its path is another file (size changed since import)', async () => {
    const { project, files } = await exportProject()
    await writeFile(files[1], 'a completely different recording')
    await expect(h.jobs.startExport(project.id)).rejects.toThrow(
      JOB_MESSAGES.changedOriginal('b.mp4')
    )
    expect(h.media.calls.render).toEqual([])
  })

  it('takes any number of clips on a Mac with 8 GB, with crossfades and with hard cuts', async () => {
    await h.dispose()
    h = await createHarness({ memoryBytes: 8 * 1024 ** 3 })
    const { project } = await exportProject()
    const videoId = project.videos[0].id
    h.store.update(project.id, (draft) => {
      draft.moments = Array.from({ length: 40 }, (_, i) =>
        makeMoment({ id: `m${i}`, videoId, start: 10, end: 11, selected: true })
      )
    })
    // no ffmpeg run opens more than two clips, so memory does not limit the length of the reel
    for (const transition of ['crossfade', 'cut'] as const) {
      h.store.update(project.id, (draft) => {
        draft.exportSettings.transition = transition
      })
      await h.jobs.startExport(project.id)
      await h.jobs.whenIdle()
    }
    expect(h.media.calls.render.map((job) => [job.settings.transition, job.clips.length])).toEqual([
      ['crossfade', 40],
      ['cut', 40]
    ])
  })

  it('starts another export only when both fit into half of the RAM', async () => {
    await h.dispose()
    h = await createHarness({ memoryBytes: 8 * 1024 ** 3 })
    const first = (await exportProject()).project
    const second = (await exportProject()).project
    const gate = h.media.hold('render')
    await h.jobs.startExport(first.id)
    await gate.reached
    // two 4K renders of 2.4 GB each are more than the 4 GB an 8 GB Mac gives ffmpeg
    await expect(h.jobs.startExport(second.id)).rejects.toThrow(JOB_MESSAGES.exportMemoryBusy)
    expect(parseIpcError(await h.jobs.startExport(second.id).catch((err: unknown) => err))).toEqual(
      { code: 'busy', message: JOB_MESSAGES.exportMemoryBusy }
    )
    expect(h.media.calls.render).toHaveLength(1)
    gate.release()
    await h.jobs.whenIdle()
    // the memory is free again
    await h.jobs.startExport(second.id)
    await h.jobs.whenIdle()
    expect(h.media.calls.render).toHaveLength(2)
  })

  it('runs exports side by side on a Mac with enough RAM', async () => {
    await h.dispose()
    h = await createHarness({ memoryBytes: 16 * 1024 ** 3 })
    const gate = h.media.hold('render')
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push((await exportProject()).project.id)
    // three 4K renders (7.2 GB) fit into 8 GB, the fourth does not
    for (const id of ids.slice(0, 3)) await h.jobs.startExport(id)
    await eventually(() => expect(gate.waiting).toBe(3))
    await expect(h.jobs.startExport(ids[3])).rejects.toThrow(JOB_MESSAGES.exportMemoryBusy)
    gate.release()
    await h.jobs.whenIdle()
  })

  it('renders one highlight video at a time on a Mac with 8 GB, also in the small formats', async () => {
    await h.dispose()
    h = await createHarness({ memoryBytes: 8 * 1024 ** 3 })
    const gate = h.media.hold('render')
    const ids: string[] = []
    for (let i = 0; i < 2; i++) ids.push((await exportProject()).project.id)
    for (const id of ids) h.store.update(id, (draft) => void (draft.exportSettings.aspect = '1:1'))
    await h.jobs.startExport(ids[0])
    await gate.reached
    // by its pixels a 1:1 frame takes 1350 MiB, so three would fit into the 4 GB – but next to
    // others every export counts as a 9:16 frame
    await expect(h.jobs.startExport(ids[1])).rejects.toThrow(JOB_MESSAGES.exportMemoryBusy)
    expect(h.media.calls.render).toHaveLength(1)
    gate.release()
    await h.jobs.whenIdle()
  })

  it('refuses a frame that alone needs more than the RAM allows, before anything is rendered', async () => {
    await h.dispose()
    h = await createHarness({ memoryBytes: 8 * 1024 ** 3 })
    const { project } = await exportProject()
    h.store.update(project.id, (draft) => {
      // "Original" of a 32:9 recording: 2160 px on the short side make a frame of 7680×2160
      for (const video of draft.videos) Object.assign(video, { width: 3840, height: 1080 })
      draft.exportSettings.aspect = 'source'
    })
    await expect(h.jobs.startExport(project.id)).rejects.toThrow(
      'This Mac does not have enough memory for this format: the picture would be too big. ' +
        'Choose another format when you export.'
    )
    expect(h.media.calls.render).toEqual([])
    expect(await pathExists(h.paths.projectTmpDir(project.id))).toBe(false)
    // every other format fits
    h.store.update(project.id, (draft) => void (draft.exportSettings.aspect = '16:9'))
    await h.jobs.startExport(project.id)
    await h.jobs.whenIdle()
    expect(h.media.calls.render).toHaveLength(1)
  })

  it('reports unknown projects', async () => {
    await expect(h.jobs.startExport('nope')).rejects.toThrow(/not-found/)
    expect(() => h.jobs.cancelExport('nope')).toThrow(/not-found/)
  })
})

describe('mapRenderProgress', () => {
  const p = (
    phase: RenderProgress['phase'],
    fraction: number,
    clipIndex?: number
  ): RenderProgress => ({ phase, fraction, clipIndex, clipCount: 3 })

  it('maps phases to messages and never goes backwards or reaches 1', () => {
    expect(mapRenderProgress(p('rendering', 0.3, 1), 0)).toEqual({
      phase: 'rendering',
      progress: 0.3,
      currentClip: 2,
      clipCount: 3,
      message: 'Rendering clip 2 of 3…'
    })
    expect(mapRenderProgress(p('joining', 0.2), 0.5).progress).toBe(0.5)
    expect(mapRenderProgress(p('finishing', 1), 0.5)).toMatchObject({
      progress: 0.99,
      message: JOB_MESSAGES.exportFinishing
    })
    expect(mapRenderProgress(p('rendering', Number.NaN, 9), 0)).toMatchObject({
      progress: 0,
      currentClip: 3
    })
  })
})
