import {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MediaError } from '../../contracts'
import { fingerprintFile } from '../../media/fingerprint'
import { DISK_FULL_MESSAGE } from '../errors'
import { pathExists } from '../fsx'
import { FAKE_FFMPEG_MISSING } from '../testing/fakeMedia'
import { makeMoment } from '../testing/fixtures'
import { createHarness, type Harness } from '../testing/harness'
import { eventually } from '../testing/helpers'
import { JOB_MESSAGES } from './messages'

let h: Harness

beforeEach(async () => {
  h = await createHarness()
})

afterEach(async () => {
  await h.dispose()
})

const prepareStates = (projectId: string): string[] => {
  const project = h.store.get(projectId)
  return project.videos.map((v) => project.status[v.id].prepare.status)
}

/** prepared project with one selected clip, and a folder on "another drive" to move it to */
async function projectWithClip(): Promise<
  Awaited<ReturnType<Harness['preparedProject']>> & { moved: string }
> {
  const prepared = await h.preparedProject(['a.mp4'])
  h.store.update(prepared.project.id, (draft) => {
    draft.moments = [
      makeMoment({ id: 'm1', videoId: prepared.videoIds[0], start: 10, end: 16, selected: true })
    ]
  })
  const ssd = join(h.temp.path, 'SSD', 'Festival')
  await mkdir(ssd, { recursive: true })
  const moved = join(ssd, 'a.mp4')
  // the user picks the moved original to add it again
  h.jobs.grantPaths([moved])
  return { ...prepared, moved }
}

describe('addVideos', () => {
  it('probes, makes posters, sorts chronologically and skips what it cannot use', async () => {
    const { id } = await h.store.create('Festival')
    const late = await h.video('late.mp4')
    const early = await h.video('early.MOV')
    const undated = await h.video('undated.mp4')
    const notes = await h.video('notes.txt')
    const folder = join(h.temp.path, 'Originals', 'clips.mp4')
    await mkdir(folder)
    h.media.probes.set(late, { recordedAt: '2026-07-12T20:30:00.000Z', durationSec: 120 })
    h.media.probes.set(early, { recordedAt: '2026-07-12T19:00:00.000Z', durationSec: 90 })
    // dropped, then deleted or turned into a folder before the import read them
    h.jobs.grantPaths(['/nope/missing.mp4', folder])

    const before = Date.now()
    const result = await h.jobs.addVideos(id, [
      late,
      early,
      undated,
      '/nope/missing.mp4',
      notes,
      late,
      'relative.mp4',
      folder
    ])

    expect(result.added).toBe(3)
    expect(result.project.videos.map((v) => v.fileName)).toEqual([
      'early.MOV',
      'late.mp4',
      'undated.mp4'
    ])
    expect(result.skipped).toEqual([
      { path: notes, reason: JOB_MESSAGES.notAVideo },
      { path: 'relative.mp4', reason: JOB_MESSAGES.invalidPath },
      { path: folder, reason: JOB_MESSAGES.folderWithoutVideos },
      { path: '/nope/missing.mp4', reason: JOB_MESSAGES.fileMissing }
    ])
    const [first, second, third] = result.project.videos
    expect(first).toMatchObject({
      path: early,
      durationSec: 90,
      recordedAt: '2026-07-12T19:00:00.000Z',
      proxyPath: null
    })
    expect(second.durationSec).toBe(120)
    // no container date → file birth time
    expect(Date.parse(third.recordedAt ?? '')).toBeGreaterThanOrEqual(before - 60_000)
    for (const video of result.project.videos) {
      expect(video.posterPath).toBe(h.paths.posterFile(id, video.id))
      expect(await pathExists(video.posterPath ?? '')).toBe(true)
      expect(result.project.status[video.id]).toEqual({
        prepare: { status: 'pending', progress: 0 },
        analysis: { stage: 'idle', progress: 0 }
      })
    }
  })

  it('adds the videos of a dropped folder: one level, sorted by name, without hidden files', async () => {
    const { id } = await h.store.create('Festival')
    const folder = join(h.temp.path, 'Meta Export')
    await mkdir(join(folder, 'Subfolder'), { recursive: true })
    for (const name of ['clip10.mp4', 'clip2.MOV', '.versteckt.mp4', '._clip2.MOV', 'notes.txt']) {
      await writeFile(join(folder, name), `data of ${name}`)
    }
    await writeFile(join(folder, 'Subfolder', 'deep.mp4'), 'deeper')
    const empty = join(h.temp.path, 'Only photos')
    await mkdir(empty)
    await writeFile(join(empty, 'photo.jpg'), 'jpg')

    // the same recording time, so the name decides (file times differ by load: written in turn)
    for (const name of ['clip10.mp4', 'clip2.MOV']) {
      h.media.probes.set(join(folder, name), { recordedAt: '2026-07-12T20:00:00.000Z' })
    }

    // handed over by the user: dropped (the preload reports it) or picked in the dialog
    h.jobs.grantPaths([folder, `${empty}/`])
    const result = await h.jobs.addVideos(id, [folder, empty])
    expect(result.added).toBe(2)
    // probed in parallel after an async stat: only the result keeps the name order
    expect(result.project.videos.map((v) => v.fileName)).toEqual(['clip2.MOV', 'clip10.mp4'])
    expect([...h.media.calls.probe].sort()).toEqual([
      join(folder, 'clip10.mp4'),
      join(folder, 'clip2.MOV')
    ])
    // other files in the folder are ignored, a folder without videos is reported as such
    expect(result.skipped).toEqual([{ path: empty, reason: JOB_MESSAGES.folderWithoutVideos }])

    // dropped again (folder and one of its files): nothing is added twice
    const again = await h.jobs.addVideos(id, [folder, join(folder, 'clip2.MOV')])
    expect(again.added).toBe(0)
    expect(again.skipped.map((s) => s.reason)).toEqual([
      JOB_MESSAGES.alreadyInProject,
      JOB_MESSAGES.alreadyInProject
    ])
  })

  it('leaves the reel as it is when an import re-sorts the videos', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4', 'b.mp4'])
    // b's clip first: a re-sort of the moments would show
    const reel = [
      makeMoment({ id: 'm2', videoId: videoIds[1], start: 5, end: 9, selected: true }),
      makeMoment({ id: 'm1', videoId: videoIds[0], start: 10, end: 16, selected: true }),
      makeMoment({ id: 'm3', videoId: videoIds[0], start: 30, end: 36 })
    ]
    h.store.update(project.id, (draft) => void (draft.moments = reel))
    const early = await h.video('early.mp4')
    h.media.probes.set(early, { recordedAt: '2026-07-12T19:00:00.000Z' })

    const result = await h.jobs.addVideos(project.id, [early])
    // recorded before the others: it becomes the first video …
    expect(result.project.videos.map((v) => v.fileName)).toEqual(['early.mp4', 'a.mp4', 'b.mp4'])
    // … and the clips keep their order and their selection
    expect(result.project.moments).toEqual(reel)
    expect(result.project.reelEdited).toBe(project.reelEdited)
  })

  it('never lists a folder the user did not hand over (a renderer script naming one)', async () => {
    const { id } = await h.store.create('Festival')
    const folder = join(h.temp.path, 'Movies')
    await mkdir(folder)
    await writeFile(join(folder, 'IMG_4711.mp4'), 'private video 1')
    await writeFile(join(folder, 'Family party.mp4'), 'private video 2')

    const result = await h.jobs.addVideos(id, [folder])
    expect(result.added).toBe(0)
    // the reason a folder got before folders could be dropped – nothing about what is inside
    expect(result.skipped).toEqual([{ path: folder, reason: JOB_MESSAGES.notAVideo }])
    expect(h.media.calls.probe).toEqual([])

    // picked in the dialog or dropped: now it may be listed
    h.jobs.grantPaths([folder])
    expect((await h.jobs.addVideos(id, [folder])).added).toBe(2)
  })

  it('never reads a file the user did not hand over (a renderer script naming one)', async () => {
    const { id } = await h.store.create('Festival')
    const folder = join(h.temp.path, 'Movies')
    await mkdir(folder)
    const secret = join(folder, 'IMG_4711.mp4')
    await writeFile(secret, 'private video')

    const result = await h.jobs.addVideos(id, [secret])
    expect(result.added).toBe(0)
    // the same reason as a folder that was not handed over: nothing about the file
    expect(result.skipped).toEqual([{ path: secret, reason: JOB_MESSAGES.notAVideo }])
    expect(h.media.calls.probe).toEqual([])
    expect(h.media.calls.fingerprint).toEqual([])

    h.jobs.grantPaths([secret])
    expect((await h.jobs.addVideos(id, [secret])).added).toBe(1)
  })

  it('prepares proxy and filmstrip in the background', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4'])
    const video = project.videos[0]
    expect(video).toMatchObject({
      proxyPath: h.paths.proxyFile(project.id, videoIds[0]),
      spritePath: h.paths.spriteFile(project.id, videoIds[0]),
      spriteInfo: { columns: 60, intervalSec: 1, tileWidth: 160, tileHeight: 213 }
    })
    expect(project.status[video.id].prepare).toEqual({ status: 'done', progress: 1 })
    expect(await pathExists(video.proxyPath ?? '')).toBe(true)
    expect(await pathExists(video.spritePath ?? '')).toBe(true)
    expect(h.media.calls.sprite).toEqual([video.proxyPath])
  })

  it('skips files that are already in the project, also under another name', async () => {
    const { id } = await h.store.create('Festival')
    const original = await h.video('a.mp4', 'same bytes')
    const copy = await h.video('Copy of a.mp4', 'same bytes')
    await h.jobs.addVideos(id, [original])
    const again = await h.jobs.addVideos(id, [original, copy])
    expect(again.added).toBe(0)
    expect(again.skipped).toEqual([
      { path: original, reason: JOB_MESSAGES.alreadyInProject },
      { path: copy, reason: JOB_MESSAGES.alreadyInProject }
    ])
    expect(await readdir(join(h.paths.projectDir(id), 'media'))).toHaveLength(1)
  })

  it('re-adding a moved original links the existing video: clips and preview stay', async () => {
    const { project, videoIds, files, moved } = await projectWithClip()
    await rename(files[0], moved)
    const { proxyPath } = h.store.get(project.id).videos[0]
    const result = await h.jobs.addVideos(project.id, [moved])
    expect(result.skipped).toEqual([])
    expect(result.added).toBe(0)
    const after = h.store.get(project.id)
    expect(after.videos.map((v) => [v.id, v.path, v.fileName, v.proxyPath])).toEqual([
      [videoIds[0], moved, 'a.mp4', proxyPath]
    ])
    expect(after.moments.map((m) => m.id)).toEqual(['m1'])
    expect(h.toasts).toContainEqual({
      level: 'success',
      message: JOB_MESSAGES.relinked(['a.mp4']),
      projectId: project.id
    })
    // the poster made while probing the moved file is dropped
    expect(await readdir(join(h.paths.projectDir(project.id), 'media'))).toEqual([videoIds[0]])
    await h.jobs.startExport(project.id)
    await h.jobs.whenIdle()
    expect(h.media.calls.render[0].clips[0].sourcePath).toBe(moved)
  })

  it('relinks a copy whose mtime changed (copy to exFAT/HFS+, plain cp)', async () => {
    // the fake's fingerprint has no mtime part
    h.media.fingerprint = (path) => fingerprintFile(path)
    const { project, videoIds, files, moved } = await projectWithClip()
    await copyFile(files[0], moved)
    const { mtimeMs } = await stat(files[0])
    await utimes(moved, new Date(), new Date(Math.floor(mtimeMs) - 3))
    await rm(files[0])
    const result = await h.jobs.addVideos(project.id, [moved])
    expect(result.added).toBe(0)
    expect(h.store.get(project.id).videos.map((v) => [v.id, v.path])).toEqual([
      [videoIds[0], moved]
    ])
  })

  it('relinks when another recording now lies at the old path', async () => {
    const { project, videoIds, files, moved } = await projectWithClip()
    await rename(files[0], moved)
    await writeFile(files[0], 'another day, same file name')
    await h.jobs.addVideos(project.id, [moved])
    expect(h.store.get(project.id).videos.map((v) => [v.id, v.path])).toEqual([
      [videoIds[0], moved]
    ])
  })

  it('passes probe errors on as skip reasons', async () => {
    const { id } = await h.store.create('Festival')
    const broken = await h.video('broken.mp4')
    h.media.failures.set(broken, {
      step: 'probe',
      error: new MediaError('probe', 'The file has no video track.')
    })
    const result = await h.jobs.addVideos(id, [broken])
    expect(result.skipped).toEqual([{ path: broken, reason: 'The file has no video track.' }])
  })

  it('skips a file that is still being copied (it changes while it is read)', async () => {
    const { id } = await h.store.create('Festival')
    const growing = await h.video('growing.mp4')
    const fingerprint = h.media.fingerprint.bind(h.media)
    h.media.fingerprint = async (path) => {
      const result = await fingerprint(path)
      await appendFile(path, 'the next megabytes of the copy')
      return result
    }
    const result = await h.jobs.addVideos(id, [growing])
    expect(result.added).toBe(0)
    expect(result.skipped).toEqual([{ path: growing, reason: JOB_MESSAGES.stillCopying }])
    // nothing of it stays behind, and once the copy is done the file can be added
    expect(await pathExists(join(h.paths.projectDir(id), 'media'))).toBe(false)
    h.media.fingerprint = fingerprint
    expect((await h.jobs.addVideos(id, [growing])).added).toBe(1)
  })

  it('needs ffmpeg', async () => {
    const { id } = await h.store.create('Festival')
    h.media.statusResult = FAKE_FFMPEG_MISSING
    await expect(h.jobs.addVideos(id, [await h.video('a.mp4')])).rejects.toThrow(/no-ffmpeg/)
  })
})

describe('preparation queue', () => {
  it('renders at most two proxies at a time', async () => {
    const gate = h.media.hold('proxy')
    const { id } = await h.store.create('Festival')
    const files = await Promise.all(['a', 'b', 'c', 'd'].map((n) => h.video(`${n}.mp4`)))
    await h.jobs.addVideos(id, files)
    await eventually(() => expect(gate.waiting).toBe(2))
    expect(prepareStates(id).sort()).toEqual(['pending', 'pending', 'running', 'running'])
    gate.release()
    await eventually(() => expect(prepareStates(id)).toEqual(['done', 'done', 'done', 'done']))
    expect(h.media.maxParallelProxies).toBe(2)
  })

  it('reports a failed preparation and retries it on request', async () => {
    const { id } = await h.store.create('Festival')
    const file = await h.video('a.mp4')
    h.media.failures.set(file, {
      step: 'proxy',
      error: new MediaError('ffmpeg', 'The preview of the video could not be created.', 'stderr')
    })
    const { project } = await h.jobs.addVideos(id, [file])
    const videoId = project.videos[0].id
    await eventually(() =>
      expect(h.store.get(id).status[videoId].prepare).toEqual({
        status: 'error',
        progress: 0,
        error: 'The preview of the video could not be created.'
      })
    )
    h.media.failures.delete(file)
    h.jobs.retryPrepare(id, videoId)
    await eventually(() => expect(h.store.get(id).status[videoId].prepare.status).toBe('done'))
    expect(() => h.jobs.retryPrepare(id, 'unknown')).toThrow(/not-found/)
  })

  it('does not start a preview that does not fit on the disk', async () => {
    // a 60 s proxy needs ~27 MB plus the reserve
    h.disk.free = 50 * 1024 * 1024
    const { id } = await h.store.create('Festival')
    const { project } = await h.jobs.addVideos(id, [await h.video('a.mp4')])
    const videoId = project.videos[0].id
    await eventually(() =>
      expect(h.store.get(id).status[videoId].prepare).toEqual({
        status: 'error',
        progress: 0,
        error: DISK_FULL_MESSAGE
      })
    )
    expect(h.media.calls.proxy).toEqual([])
    expect(h.log.text()).toContain('not enough free space')

    h.disk.free = 2 * 1024 ** 3
    h.jobs.retryPrepare(id, videoId)
    await eventually(() => expect(h.store.get(id).status[videoId].prepare.status).toBe('done'))
  })

  it('reports a full disk during the preview with the disk-full text', async () => {
    const { id } = await h.store.create('Festival')
    const file = await h.video('a.mp4')
    h.media.failures.set(file, {
      step: 'proxy',
      error: new MediaError(
        'ffmpeg',
        'The preview of the video could not be created.',
        '[mp4 @ 0x1] Error writing trailer: No space left on device'
      )
    })
    const { project } = await h.jobs.addVideos(id, [file])
    await eventually(() =>
      expect(h.store.get(id).status[project.videos[0].id].prepare.error).toBe(DISK_FULL_MESSAGE)
    )
  })

  it('does nothing on retry when a video is already prepared', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4'])
    const proxies = h.media.calls.proxy.length
    h.jobs.retryPrepare(project.id, videoIds[0])
    await h.jobs.whenIdle()
    expect(h.media.calls.proxy.length).toBe(proxies)
    expect(prepareStates(project.id)).toEqual(['done'])
  })

  it('fails with a message naming the file when the original is gone', async () => {
    const { project, videoIds, files } = await h.preparedProject(['weg.mp4'])
    await rm(files[0])
    await rm(h.paths.proxyFile(project.id, videoIds[0]))
    await h.jobs.openProject(project.id)
    await eventually(() =>
      expect(h.store.get(project.id).status[videoIds[0]].prepare).toEqual({
        status: 'error',
        progress: 0,
        error: JOB_MESSAGES.missingOriginal('weg.mp4')
      })
    )
  })

  it('rebuilds the preview of a relinked video whose original was reported missing', async () => {
    const { project, videoIds, files, moved } = await projectWithClip()
    await rename(files[0], moved)
    await rm(h.paths.proxyFile(project.id, videoIds[0]))
    await h.jobs.openProject(project.id)
    await eventually(() =>
      expect(h.store.get(project.id).status[videoIds[0]].prepare.status).toBe('error')
    )
    const result = await h.jobs.addVideos(project.id, [moved])
    // the card leaves the missing-original error right away, even while the queue is busy
    expect(result.project.status[videoIds[0]].prepare.status).toBe('pending')
    await eventually(() =>
      expect(h.store.get(project.id).status[videoIds[0]].prepare.status).toBe('done')
    )
    expect(h.media.calls.proxy.at(-1)).toBe(moved)
  })

  it('re-queues missing previews when a project is opened', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4', 'b.mp4'])
    await rm(h.paths.proxyFile(project.id, videoIds[1]))
    const proxiesBefore = h.media.calls.proxy.length
    const opened = await h.jobs.openProject(project.id)
    expect(opened.videos[1].proxyPath).toBeNull()
    await eventually(() => expect(prepareStates(project.id)).toEqual(['done', 'done']))
    expect(h.media.calls.proxy.length).toBe(proxiesBefore + 1)
    expect(await pathExists(h.paths.proxyFile(project.id, videoIds[1]))).toBe(true)
  })

  it('redoes only the missing pieces (sprite, poster) without a new proxy', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4'])
    await rm(h.paths.spriteFile(project.id, videoIds[0]))
    await rm(h.paths.posterFile(project.id, videoIds[0]))
    const before = {
      proxy: h.media.calls.proxy.length,
      sprite: h.media.calls.sprite.length,
      poster: h.media.calls.poster.length
    }
    await h.jobs.openProject(project.id)
    await h.jobs.whenIdle()
    const video = h.store.get(project.id).videos[0]
    expect(h.media.calls.proxy.length).toBe(before.proxy)
    expect(h.media.calls.sprite.length).toBe(before.sprite + 1)
    expect(h.media.calls.poster.length).toBe(before.poster + 1)
    expect(video.posterPath).toBe(h.paths.posterFile(project.id, videoIds[0]))
    expect(await pathExists(video.spritePath ?? '')).toBe(true)
    expect(h.store.get(project.id).status[videoIds[0]].prepare.status).toBe('done')
  })
})

describe('removing videos and projects', () => {
  it('cancels the preparation of a removed video and deletes its media', async () => {
    const gate = h.media.hold('proxy')
    const { id } = await h.store.create('Festival')
    const { project } = await h.jobs.addVideos(id, [await h.video('a.mp4')])
    const videoId = project.videos[0].id
    await gate.reached
    const next = await h.jobs.removeVideo(id, videoId)
    expect(next.videos).toEqual([])
    expect(next.status[videoId]).toBeUndefined()
    expect(gate.waiting).toBe(0)
    expect(await pathExists(h.paths.videoMediaDir(id, videoId))).toBe(false)
    await expect(h.jobs.removeVideo(id, videoId)).rejects.toThrow(/not-found/)
  })

  it('removes moments, analysis and the upload of a removed video', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4', 'b.mp4'])
    await h.jobs.startAnalysis(project.id)
    await h.jobs.whenIdle()
    const next = await h.jobs.removeVideo(project.id, videoIds[0])
    expect(next.moments.every((m) => m.videoId === videoIds[1])).toBe(true)
    expect(Object.keys(next.analyses)).toEqual([videoIds[1]])
    expect(Object.keys(next.remoteFiles)).toEqual([videoIds[1]])
    await eventually(() => expect(h.analyzer.deleted).toEqual(['files/a.mp4']))
  })

  it('waits for a running import, which then stops – no preview is started', async () => {
    const { id } = await h.store.create('Festival')
    const posterGate = h.media.hold('poster')
    const proxyGate = h.media.hold('proxy')
    const files = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((n) => h.video(`${n}.mp4`)))
    const late = await h.video('f.mp4')
    const adding = h.jobs.addVideos(id, files)
    await posterGate.reached
    const deleting = h.jobs.deleteProject(id)
    // nothing new starts for a project that is being deleted
    const addingMore = expect(h.jobs.addVideos(id, [late])).rejects.toThrow(/not-found/)
    const opening = expect(h.jobs.openProject(id)).rejects.toThrow(/not-found/)
    expect(() => h.jobs.autoSelect(id)).toThrow(/not-found/)
    posterGate.release()

    await addingMore
    await opening
    await expect(adding).rejects.toThrow(/not-found/)
    await deleting
    expect(h.media.calls.proxy).toEqual([])
    expect(proxyGate.waiting).toBe(0)
    // the files after the delete request were not even probed
    expect(h.media.calls.probe.length).toBeLessThan(files.length)
    expect(h.log.entries.map((e) => e.message)).not.toContain('jobs still running while deleting')
    expect(await pathExists(h.paths.projectDir(id))).toBe(false)
  })

  it('joins a second delete of the same project', async () => {
    const { id } = await h.store.create('Festival')
    const gate = h.media.hold('poster')
    const adding = h.jobs.addVideos(id, [await h.video('a.mp4')])
    await gate.reached
    const first = h.jobs.deleteProject(id)
    const second = h.jobs.deleteProject(id)
    gate.release()
    await Promise.all([first, second, adding.catch(() => undefined)])
    expect(h.store.find(id)).toBeUndefined()
    await expect(h.jobs.deleteProject(id)).rejects.toThrow(/not-found/)
  })

  it('deletes a project with running jobs', async () => {
    const { project } = await h.preparedProject(['a.mp4'])
    await h.jobs.startAnalysis(project.id)
    await h.jobs.whenIdle()
    const gate = h.media.hold('proxy')
    await h.jobs.addVideos(project.id, [await h.video('b.mp4')])
    await gate.reached
    await h.jobs.deleteProject(project.id)
    expect(await pathExists(h.paths.projectDir(project.id))).toBe(false)
    expect(h.store.find(project.id)).toBeUndefined()
    expect(await h.jobs.whenIdle(500)).toBe(true)
    await eventually(() => expect(h.analyzer.deleted).toEqual(['files/a.mp4']))
    await expect(h.jobs.deleteProject(project.id)).rejects.toThrow(/not-found/)
  })
})
