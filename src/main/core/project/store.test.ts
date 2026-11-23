import { createHash } from 'node:crypto'
import { chmod, link, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TOAST_KEYS } from '@shared/ipc'
import { DEFAULT_BRIEF, DEFAULT_EXPORT_SETTINGS } from '@shared/presets'
import type { BriefSettings, Moment, Project, VideoAnalysis } from '@shared/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { briefHash } from '../briefHash'
import { pathExists } from '../fsx'
import { isAnalysisFresh } from '../jobs/analysis'
import { applyMutation } from '../mutations'
import { createAppPaths, type AppPaths } from '../paths'
import { makeMoment, makeProject, makeVideo } from '../testing/fixtures'
import { eventually, makeTempDir, recordingLogger, type TempDir } from '../testing/helpers'
import { INTERRUPTED_MESSAGE } from './normalize'
import {
  ProjectStore,
  storeNoticeToast,
  type ProjectEvent,
  type ProjectStoreOptions,
  type StoreNotice
} from './store'

let temp: TempDir
let paths: AppPaths
let stores: ProjectStore[]

beforeEach(async () => {
  temp = await makeTempDir()
  paths = createAppPaths(temp.path)
  stores = []
})

afterEach(async () => {
  // a debounced write firing during the removal would recreate folders in the temp dir
  await Promise.all(stores.map((store) => store.close()))
  await temp.cleanup()
})

function createStore(options: Partial<Pick<ProjectStoreOptions, 'now' | 'onNotice'>> = {}): {
  store: ProjectStore
  log: ReturnType<typeof recordingLogger>
} {
  const log = recordingLogger()
  let n = 0
  const store = new ProjectStore({
    paths,
    log,
    newId: () => `id${++n}`,
    writeDelayMs: 20,
    retryDelayMs: 30,
    ...options
  })
  stores.push(store)
  return { store, log }
}

async function readProjectFile(id: string): Promise<Project> {
  return JSON.parse(await readFile(paths.projectFile(id), 'utf8')) as Project
}

async function writeRawProject(id: string, content: unknown): Promise<void> {
  await mkdir(paths.projectDir(id), { recursive: true })
  await writeFile(
    paths.projectFile(id),
    typeof content === 'string' ? content : JSON.stringify(content)
  )
}

describe('ProjectStore basics', () => {
  it('creates a project on disk right away and lists summaries', async () => {
    const { store } = createStore()
    await store.init()
    const project = await store.create('Rock am Ring')
    expect(project).toMatchObject({ id: 'id1', name: 'Rock am Ring', videos: [], moments: [] })
    expect(await readProjectFile('id1')).toEqual(project)
    expect(store.list()).toEqual([
      expect.objectContaining({
        id: 'id1',
        name: 'Rock am Ring',
        videoCount: 0,
        lastExportPath: null
      })
    ])
  })

  it('hands out frozen snapshots and throws not-found for unknown ids', async () => {
    const { store } = createStore()
    await store.init()
    const project = await store.create('A')
    expect(Object.isFrozen(project.brief)).toBe(true)
    expect(() => store.get('nope')).toThrow(/not-found/)
  })

  it('starts a new project with the export settings of the last changed one, not its folder', async () => {
    let time = Date.parse('2026-07-12T20:00:00.000Z')
    const { store } = createStore({ now: () => new Date((time += 1000)) })
    await store.init()
    // an untouched oldest project: picking by insertion or creation order would copy its defaults
    expect((await store.create('X')).exportSettings).toEqual(DEFAULT_EXPORT_SETTINGS)
    const first = await store.create('A')
    expect(first.exportSettings).toEqual(DEFAULT_EXPORT_SETTINGS)
    await store.create('B')
    store.update(first.id, (draft) => {
      Object.assign(draft.exportSettings, {
        aspect: '4:5',
        fit: 'blur',
        transition: 'crossfade',
        outputDir: '/Users/demo/Reels'
      })
      draft.brief.prompt = 'Only fireworks'
    })
    const next = await store.create('C')
    expect(next.exportSettings).toEqual({
      aspect: '4:5',
      fit: 'blur',
      transition: 'crossfade',
      outputDir: null
    })
    expect(next.brief).toEqual(DEFAULT_BRIEF)
  })

  it('applies recipes to a copy, stamps a strictly increasing updatedAt and announces changes', async () => {
    const fixed = new Date('2026-07-12T20:00:00.000Z')
    const { store } = createStore({ now: () => fixed })
    await store.init()
    const created = await store.create('A')
    const events: ProjectEvent[] = []
    store.subscribe((event) => events.push(event))

    const first = store.update(created.id, (draft) => {
      draft.name = 'B'
    })
    const second = store.update(created.id, (draft) => ({ ...draft, name: 'C' }))
    expect(created.name).toBe('A')
    expect(first.updatedAt > created.updatedAt).toBe(true)
    expect(second.updatedAt > first.updatedAt).toBe(true)
    expect(events.map((e) => (e.type === 'updated' ? e.project.name : e.type))).toEqual(['B', 'C'])
  })

  it('debounces writes, writes the latest state and flushes on demand', async () => {
    const { store } = createStore()
    await store.init()
    const { id } = await store.create('A')
    for (let i = 1; i <= 5; i++) store.update(id, (draft) => void (draft.name = `Name ${i}`))
    expect((await readProjectFile(id)).name).toBe('A')
    await eventually(async () => expect((await readProjectFile(id)).name).toBe('Name 5'))

    store.update(id, (draft) => void (draft.name = 'Final'))
    await store.flush()
    expect((await readProjectFile(id)).name).toBe('Final')
    const leftovers = (await readdir(paths.projectDir(id))).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('saves a change made while the final flush is writing', async () => {
    const { store } = createStore()
    await store.init()
    const { id } = await store.create('A')
    store.update(id, (draft) => void (draft.name = 'B'))
    const closing = store.close()
    // the write of "B" has started (it took its snapshot) and is waiting for the disk
    await Promise.resolve()
    store.update(id, (draft) => void (draft.name = 'C'))
    await closing
    expect((await readProjectFile(id)).name).toBe('C')
  })

  it('does not persist progress-only updates on their own', async () => {
    const { store } = createStore()
    await store.init()
    const { id } = await store.create('A')
    store.update(id, (draft) => void (draft.name = 'transient'), { persist: false })
    await new Promise((resolve) => setTimeout(resolve, 60))
    await store.flush()
    expect((await readProjectFile(id)).name).toBe('A')
    expect(store.get(id).name).toBe('transient')
  })

  it('retries a failed write', async () => {
    const { store, log } = createStore()
    await store.init()
    const { id } = await store.create('A')
    await chmod(paths.projectDir(id), 0o500)
    try {
      store.update(id, (draft) => void (draft.name = 'B'))
      await eventually(() => expect(log.entries.some((e) => e.level === 'error')).toBe(true))
    } finally {
      await chmod(paths.projectDir(id), 0o755)
    }
    await eventually(async () => expect((await readProjectFile(id)).name).toBe('B'))
  })

  it('reports failed saves once per streak and announces when everything is saved again', async () => {
    const notices: StoreNotice[] = []
    const { store, log } = createStore({ onNotice: (notice) => notices.push(notice) })
    await store.init()
    const a = await store.create('A')
    const b = await store.create('B')
    const errors = (): number => log.entries.filter((e) => e.level === 'error').length
    await chmod(paths.projectDir(a.id), 0o500)
    await chmod(paths.projectDir(b.id), 0o500)
    try {
      store.update(a.id, (draft) => void (draft.name = 'A2'))
      store.update(b.id, (draft) => void (draft.name = 'B2'))
      // both projects fail, and keep failing on every retry – still one notice
      await eventually(() => expect(errors()).toBeGreaterThanOrEqual(4))
      expect(notices).toEqual([{ type: 'save-failed' }])
      await chmod(paths.projectDir(a.id), 0o755)
      await eventually(async () => expect((await readProjectFile(a.id)).name).toBe('A2'))
      // B still fails: not everything is saved yet
      const failures = errors()
      await eventually(() => expect(errors()).toBeGreaterThan(failures))
      expect(notices).toEqual([{ type: 'save-failed' }])
    } finally {
      await chmod(paths.projectDir(a.id), 0o755)
      await chmod(paths.projectDir(b.id), 0o755)
    }
    await eventually(async () => expect((await readProjectFile(b.id)).name).toBe('B2'))
    // the notice follows the write: the file is readable a moment before
    await eventually(() =>
      expect(notices).toEqual([{ type: 'save-failed' }, { type: 'save-recovered' }])
    )

    // a new streak is reported again
    await chmod(paths.projectDir(a.id), 0o500)
    try {
      store.update(a.id, (draft) => void (draft.name = 'A3'))
      await eventually(() => expect(notices).toHaveLength(3))
    } finally {
      await chmod(paths.projectDir(a.id), 0o755)
    }
    await eventually(() => expect(notices).toHaveLength(4))
    expect(notices.slice(2)).toEqual([{ type: 'save-failed' }, { type: 'save-recovered' }])
  })

  it('turns store notices into toasts', () => {
    // announced once per streak: it stays until the recovery toast (same key) replaces it
    expect(storeNoticeToast({ type: 'save-failed' })).toEqual({
      level: 'warning',
      message:
        'Your changes cannot be saved right now. Is the disk full? As soon as there is space ' +
        'again, the app goes on saving by itself.',
      sticky: true,
      key: TOAST_KEYS.projectSave
    })
    expect(storeNoticeToast({ type: 'save-recovered' })).toEqual({
      level: 'success',
      message: 'Everything is saved again.',
      key: TOAST_KEYS.projectSave
    })
    expect(storeNoticeToast({ type: 'restored', projectId: 'p1', name: 'Festival' })).toEqual({
      level: 'warning',
      message:
        '“Festival” was damaged and was restored from the last backup. The latest changes may ' +
        'be missing.',
      sticky: true
    })
    expect(storeNoticeToast({ type: 'unreadable', count: 1 }).message).toBe(
      '1 project could not be opened. You can find details in Settings under System → Log file.'
    )
    expect(storeNoticeToast({ type: 'unreadable', count: 2 })).toEqual({
      level: 'error',
      message:
        '2 projects could not be opened. You can find details in Settings under System → Log file.',
      sticky: true
    })
  })

  it('deletes the folder incl. media and never resurrects it with a pending write', async () => {
    const { store } = createStore()
    await store.init()
    const { id } = await store.create('A')
    const media = paths.videoMediaDir(id, 'v1')
    await mkdir(media, { recursive: true })
    await writeFile(join(media, 'proxy.mp4'), 'x')
    const events: ProjectEvent[] = []
    store.subscribe((event) => events.push(event))

    store.update(id, (draft) => void (draft.name = 'B'))
    await store.delete(id)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(await pathExists(paths.projectDir(id))).toBe(false)
    expect(store.find(id)).toBeUndefined()
    expect(events.at(-1)).toEqual({ type: 'deleted', projectId: id })
    await expect(store.delete(id)).rejects.toThrow(/not-found/)
  })

  it('knows original video paths and export paths', async () => {
    const { store } = createStore()
    await store.init()
    const { id } = await store.create('A')
    store.update(id, (draft) => {
      draft.videos.push(makeVideo({ id: 'v1', path: '/Users/jan/Movies/clip.mp4' }))
      draft.exports.push({
        id: 'e1',
        path: '/Users/jan/Movies/out.mp4',
        createdAt: draft.createdAt,
        durationSec: 30,
        clipCount: 3,
        sizeBytes: 1
      })
    })
    expect(store.hasVideoPath('/Users/jan/Movies/./clip.mp4')).toBe(true)
    expect(store.hasVideoPath('/Users/jan/Movies/other.mp4')).toBe(false)
    expect(store.hasExportPath('/Users/jan/Movies/out.mp4')).toBe(true)
    expect(store.hasExportPath('/Users/jan/Movies/clip.mp4')).toBe(false)
  })
})

describe('ProjectStore loading', () => {
  function storedProject(): Project {
    const video = makeVideo({
      id: 'v1',
      durationSec: 60,
      proxyPath: '/data/proxy.mp4',
      spritePath: '/data/sprite.jpg',
      spriteInfo: { columns: 60, intervalSec: 1, tileWidth: 160, tileHeight: 213 }
    })
    const v2 = makeVideo({ id: 'v2', durationSec: 30 })
    return makeProject({
      id: 'p1',
      videos: [video, v2],
      status: {
        v1: {
          prepare: { status: 'done', progress: 1 },
          analysis: { stage: 'uploading', progress: 0.4, startedAt: '2026-07-12T20:01:00.000Z' }
        },
        v2: {
          prepare: { status: 'running', progress: 0.5 },
          analysis: { stage: 'done', progress: 1, message: '3 moments found' }
        }
      },
      moments: [
        makeMoment({ id: 'm1', videoId: 'v1', start: 1, end: 5, selected: true }),
        makeMoment({ id: 'm1', videoId: 'v1', start: 10, end: 14 }),
        makeMoment({ id: 'm3', videoId: 'gone', start: 1, end: 5 }),
        makeMoment({ id: 'm4', videoId: 'v2', start: 10, end: 10.2 }),
        makeMoment({ id: 'm5', videoId: 'v2', start: 25, end: 40 })
      ]
    })
  }

  it('normalises, resets transient states and persists the repaired file', async () => {
    await writeRawProject('p1', storedProject())
    const { store } = createStore()
    await store.init()
    const project = store.get('p1')

    expect(project.status.v1).toEqual({
      prepare: { status: 'done', progress: 1 },
      analysis: {
        stage: 'cancelled',
        progress: 0,
        message: INTERRUPTED_MESSAGE,
        startedAt: '2026-07-12T20:01:00.000Z'
      }
    })
    expect(project.status.v2.prepare).toEqual({ status: 'pending', progress: 0 })
    expect(project.status.v2.analysis.stage).toBe('done')
    // duplicate id replaced, unknown video and too-short moment dropped, overlong one clamped
    expect(project.moments.map((m) => [m.id, m.videoId, m.start, m.end])).toEqual([
      ['m1', 'v1', 1, 5],
      ['id1', 'v1', 10, 14],
      ['m5', 'v2', 25, 30]
    ])

    await store.flush()
    expect(await readProjectFile('p1')).toEqual(project)
  })

  it('turns the status texts of a project saved by the German build into English', async () => {
    const ids = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6']
    const prepareError = (error: string): Project['status'][string]['prepare'] => ({
      status: 'error',
      progress: 0,
      error
    })
    await writeRawProject(
      'p1',
      makeProject({
        id: 'p1',
        videos: ids.map((id) => makeVideo({ id, durationSec: 30 })),
        status: {
          v1: {
            prepare: prepareError(
              'Die Originaldatei „VID_1.mp4“ wurde nicht gefunden. Wurde sie verschoben? Dann füg sie vom neuen Ort erneut hinzu – deine Clips bleiben erhalten.'
            ),
            analysis: { stage: 'done', progress: 1, message: '5 Momente gefunden' }
          },
          v2: {
            prepare: prepareError('Die Datei „VID 2 – Bühne.mp4“ wurde nicht gefunden.'),
            analysis: { stage: 'done', progress: 1, message: '1 Moment gefunden' }
          },
          v3: {
            prepare: prepareError('Die Vorschau konnte nicht erstellt werden.'),
            analysis: { stage: 'done', progress: 1, message: 'Keine passenden Momente gefunden' }
          },
          v4: {
            prepare: { status: 'done', progress: 1 },
            analysis: { stage: 'cancelled', progress: 0, message: 'Abgebrochen' }
          },
          v5: {
            prepare: { status: 'done', progress: 1 },
            analysis: { stage: 'cancelled', progress: 0, message: 'Unterbrochen' }
          },
          v6: {
            prepare: { status: 'done', progress: 1 },
            analysis: {
              stage: 'error',
              progress: 0,
              error:
                'Dein Tageskontingent bei Gemini ist aufgebraucht. Versuch es morgen wieder oder aktiviere die Abrechnung in Google AI Studio.',
              remedy: 'settings'
            }
          }
        }
      })
    )
    const { store } = createStore()
    await store.init()
    const { status } = store.get('p1')

    expect(ids.map((id) => [status[id].prepare.error, status[id].analysis.message])).toEqual([
      [
        'The original file “VID_1.mp4” was not found. Was it moved? Then add it again from its new place. Your clips are kept.',
        '5 moments found'
      ],
      [
        'The original file “VID 2 – Bühne.mp4” was not found. Was it moved? Then add it again from its new place. Your clips are kept.',
        '1 moment found'
      ],
      ['The preview could not be created.', 'No matching moments found'],
      [undefined, 'Cancelled'],
      [undefined, INTERRUPTED_MESSAGE],
      [undefined, undefined]
    ])
    // an unknown German reason gives way to the renderer's English fallback; the remedy stays
    expect(status.v6.analysis).toEqual({ stage: 'error', progress: 0, remedy: 'settings' })
  })

  it('keeps English status texts, also with German words in a quoted file name', async () => {
    const error = 'The original file “Mit Freunden – Bühne.mp4” was not found.'
    await writeRawProject(
      'p1',
      makeProject({
        id: 'p1',
        videos: [makeVideo({ id: 'v1', durationSec: 30 })],
        status: {
          v1: {
            prepare: { status: 'error', progress: 0, error },
            analysis: { stage: 'error', progress: 0, error: `The analysis failed: ${error}` }
          }
        }
      })
    )
    const { store } = createStore()
    await store.init()
    const { v1 } = store.get('p1').status

    expect([v1.prepare.error, v1.analysis.error]).toEqual([error, `The analysis failed: ${error}`])
  })

  it('loads a complete, valid project unchanged and leaves its file unchanged', async () => {
    // every field set, and to a value other than its default, so dropping any of them shows
    const brief: BriefSettings = { prompt: 'Only the drops and the crowd.', targetDurationSec: 90 }
    const v1 = makeVideo({
      id: 'v1',
      path: '/Movies/Brille/v1.mp4',
      fileName: 'Festival.mp4',
      sizeBytes: 123_456,
      durationSec: 60,
      width: 1080,
      height: 1440,
      hasAudio: false,
      recordedAt: '2026-07-12T20:01:00.000Z',
      fingerprint: 'fp-x',
      proxyPath: '/data/proxy.mp4',
      posterPath: '/data/poster.jpg',
      spritePath: '/data/sprite.jpg',
      spriteInfo: { columns: 60, intervalSec: 1, tileWidth: 160, tileHeight: 213 }
    })
    const full = makeProject({
      name: 'Summer 2026',
      updatedAt: '2026-07-13T09:00:00.000Z',
      videos: [v1, makeVideo({ id: 'v2', durationSec: 30 })],
      status: {
        v1: {
          prepare: { status: 'done', progress: 1 },
          analysis: {
            stage: 'done',
            progress: 1,
            message: '2 moments found',
            startedAt: '2026-07-12T20:02:00.000Z',
            finishedAt: '2026-07-12T20:03:00.000Z'
          }
        },
        v2: {
          prepare: { status: 'error', progress: 0.25, error: 'broken' },
          analysis: { stage: 'error', progress: 0.5, error: 'Quota', remedy: 'settings' }
        }
      },
      brief,
      analyses: {
        v1: {
          videoId: 'v1',
          model: 'gemini-3.8-flash',
          briefHash: briefHash(brief, 'gemini-3.8-flash'),
          createdAt: '2026-07-12T20:03:00.000Z'
        }
      },
      remoteFiles: {
        v1: {
          name: 'files/abc',
          uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
          mimeType: 'video/quicktime',
          expiresAt: '2026-07-14T20:00:00.000Z',
          proxyFingerprint: 'pfp'
        }
      },
      moments: [
        makeMoment({
          id: 'm1',
          videoId: 'v1',
          start: 2,
          end: 6,
          aiStart: 1,
          aiEnd: 6,
          selected: true,
          score: 9,
          title: 'Drop',
          reason: 'Loud.'
        }),
        makeMoment({
          id: 'm2',
          videoId: 'v1',
          start: 10,
          end: 13,
          autoTrimmedFrom: { start: 9, end: 15 },
          aiStart: 9,
          aiEnd: 15,
          selected: true
        }),
        makeMoment({ id: 'm3', videoId: 'v1', start: 20, end: 24, score: 3 }),
        makeMoment({
          id: 'm4',
          videoId: 'v2',
          start: 3,
          end: 8,
          score: 10,
          selected: true
        })
      ],
      reelEdited: true,
      exportSettings: {
        aspect: '4:5',
        fit: 'blur',
        transition: 'crossfade',
        outputDir: '/Users/x/Movies/Out'
      },
      exports: [
        {
          id: 'e1',
          path: '/Users/x/Movies/Out/a.mp4',
          createdAt: '2026-07-13T08:00:00.000Z',
          durationSec: 42.5,
          clipCount: 3,
          sizeBytes: 12345
        }
      ]
    })
    await writeRawProject('p1', full)
    const { store } = createStore()
    await store.init()
    expect(store.get('p1')).toEqual(full)
    await store.close()
    expect(await readProjectFile('p1')).toEqual(full)
  })

  it('keeps what can help after a failed analysis, for failed analyses only', async () => {
    const videos = ['v1', 'v2', 'v3', 'v4'].map((id) => makeVideo({ id, durationSec: 60 }))
    const analysis = (stage: string, remedy: unknown): unknown => ({
      prepare: { status: 'pending', progress: 0 },
      analysis: { stage, progress: 0, error: 'Broken.', remedy }
    })
    await writeRawProject('p4', {
      ...makeProject({ id: 'p4', videos }),
      status: {
        v1: analysis('error', 'settings'),
        v2: analysis('error', 'bogus'),
        v3: analysis('done', 'retry'),
        v4: analysis('analyzing', 'retry')
      }
    })
    const { store } = createStore()
    await store.init()
    const status = store.get('p4').status
    expect(status.v1.analysis).toMatchObject({ stage: 'error', remedy: 'settings' })
    expect(status.v2.analysis.remedy).toBeUndefined()
    expect(status.v3.analysis.remedy).toBeUndefined()
    // interrupted: cancelled, nothing to fix
    expect(status.v4.analysis).toMatchObject({ stage: 'cancelled' })
    expect(status.v4.analysis.remedy).toBeUndefined()
  })

  it('keeps a valid auto-trim marker only', async () => {
    const from = (start: number, end: number): Moment['autoTrimmedFrom'] => ({ start, end })
    await writeRawProject(
      'p3',
      makeProject({
        id: 'p3',
        videos: [makeVideo({ id: 'v1', durationSec: 60 })],
        moments: [
          {
            ...makeMoment({ id: 'a', videoId: 'v1', start: 2, end: 6 }),
            autoTrimmedFrom: from(0, 8)
          },
          {
            ...makeMoment({ id: 'c', videoId: 'v1', start: 20, end: 24 }),
            autoTrimmedFrom: from(22, 22.1)
          },
          {
            ...makeMoment({ id: 'd', videoId: 'v1', start: 50, end: 58 }),
            autoTrimmedFrom: from(50, 90)
          }
        ]
      })
    )
    const { store } = createStore()
    await store.init()
    expect(store.get('p3').moments.map((m) => [m.id, m.autoTrimmedFrom ?? null])).toEqual([
      ['a', { start: 0, end: 8 }],
      ['c', null],
      ['d', { start: 50, end: 60 }]
    ])
  })

  it('opens a project of a build with clip-length and quality options: they are dropped, its analyses stay fresh', async () => {
    const model = 'gemini-3.8-flash'
    // the brief as that build wrote it
    const oldBrief = {
      prompt: 'Show the best dance moments.\n',
      presetId: 'concert',
      targetDurationSec: 90,
      minClipSec: 3.5,
      maxClipSec: 12,
      analysisQuality: 'detailed'
    }
    // its hash covered the removed options; its first versions hashed the prompt as typed
    const oldHash = (
      prompt: string,
      options = { minClipSec: 3.5, maxClipSec: 12, analysisQuality: 'detailed' }
    ): string =>
      createHash('sha1')
        .update(JSON.stringify({ prompt, ...options, model }))
        .digest('hex')
        .slice(0, 12)
    const analysis = (videoId: string, hash: string): VideoAnalysis => ({
      videoId,
      model,
      briefHash: hash,
      createdAt: '2026-07-12T20:00:00.000Z'
    })
    const done = {
      prepare: { status: 'done' as const, progress: 1 },
      analysis: { stage: 'done' as const, progress: 1 }
    }
    await writeRawProject('p5', {
      ...makeProject({
        id: 'p5',
        videos: ['v1', 'v2', 'v3', 'v4'].map((id) => makeVideo({ id })),
        status: { v1: done, v2: done, v3: done, v4: done },
        analyses: {
          v1: analysis('v1', oldHash(oldBrief.prompt.trim())),
          v2: analysis('v2', oldHash(oldBrief.prompt)),
          // v3 belongs to an earlier prompt: it stays stale
          v3: analysis('v3', 'aaaaaaaaaaaa'),
          // v4 was analysed before the user changed the options, which are gone now
          v4: analysis(
            'v4',
            oldHash(oldBrief.prompt.trim(), {
              minClipSec: 2,
              maxClipSec: 8,
              analysisQuality: 'balanced'
            })
          )
        }
      }),
      brief: oldBrief
    })
    const { store } = createStore()
    await store.init()
    const project = store.get('p5')
    expect(project.brief).toEqual({ prompt: oldBrief.prompt, targetDurationSec: 90 })
    const current = briefHash(project.brief, model)
    expect(isAnalysisFresh(project, 'v1', current)).toBe(true)
    expect(isAnalysisFresh(project, 'v2', current)).toBe(true)
    expect(isAnalysisFresh(project, 'v3', current)).toBe(false)
    expect(project.analyses.v3.briefHash).toBe('aaaaaaaaaaaa')
    expect(isAnalysisFresh(project, 'v4', current)).toBe(true)
    // written back once in the new shape, which opens the same way
    await store.flush()
    expect(await readProjectFile('p5')).toEqual(project)
    await store.close()
    const { store: reopened } = createStore()
    await reopened.init()
    expect(reopened.get('p5')).toEqual(project)
  })

  it('opens a project of the German build: its German default prompt stays, and so does its analysis', async () => {
    const model = 'gemini-3.8-flash'
    // the default prompt until the app became English, as a project of that build holds it
    const germanDefault =
      'Mach ein mitreißendes Highlight-Video aus meinen Aufnahmen. Achte auf die stärksten ' +
      'Musikmomente (Drops, Refrains, bei denen die Crowd mitsingt), jubelnde, tanzende oder ' +
      'springende Menschen, Lichtshow, Pyro und Konfetti und auf Momente mit meinen Freunden: ' +
      'Lachen, Anstoßen, Tanzen und gute Gespräche (nicht mitten im Satz schneiden). ' +
      'Lass Laufwege, Warteschlangen und Szenen weg, in denen nichts passiert oder die Kamera ' +
      'nur auf den Boden oder das Handy zeigt. Wackeln beim Springen und Tanzen ist okay.'
    expect(DEFAULT_BRIEF.prompt).not.toBe(germanDefault)
    // the hash as that build stored it: the prompt and the model, nothing of the texts Gemini gets
    const storedHash = createHash('sha1')
      .update(JSON.stringify({ prompt: germanDefault, model }))
      .digest('hex')
      .slice(0, 12)
    const brief = { prompt: germanDefault, targetDurationSec: 60 }
    await writeRawProject(
      'p9',
      makeProject({
        id: 'p9',
        brief,
        videos: [makeVideo({ id: 'v1' })],
        status: {
          v1: { prepare: { status: 'done', progress: 1 }, analysis: { stage: 'done', progress: 1 } }
        },
        analyses: {
          v1: { videoId: 'v1', model, briefHash: storedHash, createdAt: '2026-11-01T20:00:00.000Z' }
        },
        moments: [
          makeMoment({ id: 'm1', videoId: 'v1', start: 12, end: 17, title: 'Drop mit Lichtshow' })
        ]
      })
    )
    const { store } = createStore()
    await store.init()
    const project = store.get('p9')
    expect(project.brief).toEqual(brief)
    expect(project.analyses.v1.briefHash).toBe(storedHash)
    expect(isAnalysisFresh(project, 'v1', briefHash(project.brief, model))).toBe(true)
    // the clips Gemini named in German stay as they are
    expect(project.moments.map((m) => m.title)).toEqual(['Drop mit Lichtshow'])
  })

  it('opens a project of a build that stored what nobody reads: those fields go, the analysis stays valid', async () => {
    const model = 'gemini-3.8-flash'
    const base = makeProject({ id: 'p8' })
    const hash = briefHash(base.brief, model)
    // as that build wrote them: probe details per video, Gemini's summary and tags, token usage
    await writeRawProject('p8', {
      ...base,
      videos: [{ ...makeVideo({ id: 'v1' }), rotation: 90, fps: 29.97, videoCodec: 'hevc' }],
      status: {
        v1: { prepare: { status: 'done', progress: 1 }, analysis: { stage: 'done', progress: 1 } }
      },
      analyses: {
        v1: {
          videoId: 'v1',
          model,
          briefHash: hash,
          summary: 'An evening at the festival.',
          createdAt: '2026-07-12T20:03:00.000Z',
          usage: { promptTokens: 10, outputTokens: 2, thoughtsTokens: 1, totalTokens: 13 },
          momentCount: 1
        }
      },
      moments: [
        {
          ...makeMoment({ id: 'm1', videoId: 'v1', start: 2, end: 6, selected: true }),
          tags: ['Drop', 'Crowd']
        }
      ]
    })
    const { store } = createStore()
    await store.init()
    const project = store.get('p8')
    expect(project.videos).toEqual([makeVideo({ id: 'v1' })])
    expect(project.analyses.v1).toEqual({
      videoId: 'v1',
      model,
      briefHash: hash,
      createdAt: '2026-07-12T20:03:00.000Z'
    })
    expect(isAnalysisFresh(project, 'v1', hash)).toBe(true)
    expect(project.moments).toEqual([
      makeMoment({ id: 'm1', videoId: 'v1', start: 2, end: 6, selected: true })
    ])
    for (const gone of ['rotation', 'videoCodec', 'summary', 'usage', 'momentCount', 'tags']) {
      expect(JSON.stringify(project)).not.toContain(`"${gone}"`)
    }
    // written back once in the new shape, which opens the same way
    await store.flush()
    expect(await readProjectFile('p8')).toEqual(project)
  })

  it('opens a project of a build with more export options: they are dropped, its exports stay', async () => {
    // the export settings as that build wrote them: resolution, frame rate, codec, quality, fades,
    // loudness and crossfade length were choices then (fixed now: EXPORT_FIXED)
    const oldSettings = {
      aspect: '4:5',
      fit: 'blur',
      resolution: '1440p',
      fps: 25,
      transition: 'crossfade',
      transitionSec: 0.6,
      fadeInOut: false,
      normalizeAudio: false,
      codec: 'hevc',
      quality: 'standard',
      outputDir: '/Users/x/Movies/Out'
    }
    const exports: Project['exports'] = [
      {
        id: 'e1',
        path: '/Users/x/Movies/Out/Sommer – Highlights 2026-07-13 10.00.mp4',
        createdAt: '2026-07-13T08:00:00.000Z',
        durationSec: 42.5,
        clipCount: 3,
        sizeBytes: 12_345_678
      }
    ]
    const video = makeVideo({ id: 'v1', durationSec: 60 })
    const moments = [makeMoment({ id: 'm1', videoId: 'v1', start: 1, end: 6, selected: true })]
    await writeRawProject('p6', {
      ...makeProject({ id: 'p6', videos: [video], moments, exports }),
      exportSettings: oldSettings
    })
    const { store } = createStore()
    await store.init()
    const project = store.get('p6')
    expect(project.exportSettings).toEqual({
      aspect: '4:5',
      fit: 'blur',
      transition: 'crossfade',
      outputDir: '/Users/x/Movies/Out'
    })
    expect(project.exports).toEqual(exports)
    expect(project.moments).toEqual(moments)
    // a new project copies what is left of them
    expect((await store.create('New')).exportSettings).toEqual({
      ...project.exportSettings,
      outputDir: null
    })
    // written back once in the new shape, which opens the same way
    await store.flush()
    expect(await readProjectFile('p6')).toEqual(project)
    await store.close()
    const { store: reopened } = createStore()
    await reopened.init()
    expect(reopened.get('p6')).toEqual(project)
  })

  it('opens a project of a build with own clips: they stay in the reel as normal clips', async () => {
    const video = makeVideo({ id: 'v1', durationSec: 60 })
    const ai = makeMoment({ id: 'a', videoId: 'v1', start: 20, end: 26 })
    // an own clip had no AI times
    const own = {
      id: 'own',
      videoId: 'v1',
      start: 3.25,
      end: 15.25,
      title: 'My favourite moment',
      reason: 'Added by you.',
      score: 10,
      selected: true
    }
    const late = { ...own, id: 'late', start: 40, end: 50, title: 'Own clip', selected: false }
    await writeRawProject('p7', {
      ...makeProject({ id: 'p7', videos: [video], reelEdited: true }),
      // as that build wrote them: every moment with its origin and tags; the user had moved the
      // own clip behind Gemini's
      moments: [
        { ...ai, origin: 'ai', tags: ['Drop'] },
        { ...own, origin: 'manual', tags: [] },
        { ...late, origin: 'manual', tags: [] }
      ]
    })
    const { store } = createStore()
    await store.init()
    const project = store.get('p7')
    expect(project.moments).toEqual([ai, own, late])
    for (const moment of project.moments) expect(moment).not.toHaveProperty('origin')
    expect(project.reelEdited).toBe(true)
    // from now on it is a clip like Gemini's: the automatic selection may leave it out
    const short = applyMutation(
      { ...project, reelEdited: false },
      { type: 'setBrief', patch: { targetDurationSec: 10 } }
    )
    expect(short.moments.filter((m) => m.selected).map((m) => m.id)).toEqual(['late'])
    // written back once in the new shape, which opens the same way
    await store.flush()
    expect(await readProjectFile('p7')).toEqual(project)
    await store.close()
    const { store: reopened } = createStore()
    await reopened.init()
    expect(reopened.get('p7')).toEqual(project)
  })

  it('reads the reelEdited flag; files without it count as an automatic reel', async () => {
    const legacy: Partial<Project> = makeProject({ id: 'old' })
    delete legacy.reelEdited
    await writeRawProject('old', legacy)
    await writeRawProject('edited', makeProject({ id: 'edited', reelEdited: true }))
    await writeRawProject('bogus', { ...makeProject({ id: 'bogus' }), reelEdited: 'yes' })
    const { store } = createStore()
    await store.init()
    expect(store.get('old').reelEdited).toBe(false)
    expect(store.get('edited').reelEdited).toBe(true)
    expect(store.get('bogus').reelEdited).toBe(false)
    // the repaired file gets the flag
    await store.flush()
    expect((await readProjectFile('old')).reelEdited).toBe(false)
  })

  it('fills in missing settings and drops invalid videos', async () => {
    await writeRawProject('p2', {
      id: 'something-else',
      name: '  Summer  ',
      videos: [
        { id: 'v1', path: 'relative.mp4', durationSec: 10 },
        { id: 'v2', path: '/a/b.mov', durationSec: 12 }
      ],
      brief: { prompt: 'Only drops', targetDurationSec: 'x' },
      exportSettings: { aspect: '1:1', fit: 'stretch' }
    })
    const { store } = createStore()
    await store.init()
    const project = store.get('p2')
    expect(project).toMatchObject({ id: 'p2', name: 'Summer', schemaVersion: 1 })
    expect(project.videos.map((v) => [v.id, v.fileName])).toEqual([['v2', 'b.mov']])
    expect(project.status.v2.prepare.status).toBe('pending')
    expect(project.brief).toEqual({ prompt: 'Only drops', targetDurationSec: 60 })
    expect(project.exportSettings).toEqual({ ...DEFAULT_EXPORT_SETTINGS, aspect: '1:1' })
  })

  it('drops a stored upload whose name or uri is not from Gemini (it is uploaded again)', async () => {
    const remote = {
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123',
      mimeType: 'video/mp4',
      expiresAt: '2026-07-14T20:00:00.000Z',
      proxyFingerprint: 'pfp'
    }
    const videos = ['v1', 'v2', 'v3', 'v4'].map((id) => makeVideo({ id, path: `/a/${id}.mp4` }))
    await writeRawProject('p1', {
      ...makeProject({ id: 'p1', videos }),
      remoteFiles: {
        v1: { ...remote, name: 'files/abc123' },
        v2: { ...remote, name: '../cachedContents/x?y=1' },
        v3: { ...remote, name: 'files/abc123', uri: 'https://example.com/v1beta/files/abc123' },
        v4: { ...remote, name: `files/${'a'.repeat(41)}` }
      }
    })
    const { store } = createStore()
    await store.init()
    expect(Object.keys(store.get('p1').remoteFiles)).toEqual(['v1'])
  })

  it.each([
    '__proto__',
    'constructor',
    'prototype',
    'toString',
    'valueOf',
    'hasOwnProperty',
    '__defineGetter__'
  ])('drops a video with the id %s: it would be a key of the id-keyed objects', async (id) => {
    const videos = [makeVideo({ id, path: '/a/x.mp4' }), makeVideo({ id: 'v2', path: '/a/y.mp4' })]
    const status = { prepare: { status: 'done', progress: 1 }, analysis: { stage: 'idle' } }
    // as JSON.parse reads it: "__proto__" becomes an own key of the parsed objects
    await writeRawProject(
      'p1',
      JSON.stringify({ ...makeProject({ id: 'p1', videos }), status: { v2: status } }).replace(
        '"status":{',
        `"status":{"${id}":${JSON.stringify(status)},`
      )
    )
    const { store } = createStore()
    await store.init()
    const project = store.get('p1')
    expect(project.videos.map((v) => v.id)).toEqual(['v2'])
    expect(Object.getPrototypeOf(project.status)).toBe(Object.prototype)
    expect(Object.hasOwn(project.analyses, id)).toBe(false)
    expect(Object.hasOwn(project.remoteFiles, id)).toBe(false)
    const next = store.update('p1', (draft) => void (draft.name = 'Renamed'))
    expect(Object.keys(next.status)).toEqual(['v2'])
  })

  it('skips corrupt files and newer schema versions without touching them', async () => {
    await writeRawProject('bad', '{ not json')
    await writeRawProject('future', { ...makeProject({ id: 'future' }), schemaVersion: 2 })
    await writeRawProject('ok', makeProject({ id: 'ok' }))
    const notices: StoreNotice[] = []
    const { store, log } = createStore({ onNotice: (notice) => notices.push(notice) })
    await store.init()
    await store.flush()
    expect(store.list().map((s) => s.id)).toEqual(['ok'])
    expect(await readFile(paths.projectFile('bad'), 'utf8')).toBe('{ not json')
    expect((await readProjectFile('future')).schemaVersion).toBe(2)
    expect(log.entries.filter((e) => e.message.includes('skipped'))).toHaveLength(2)
    // one notice for the whole start
    expect(notices).toEqual([{ type: 'unreadable', count: 2 }])
  })

  it('keeps the previous version as project.json.bak on every save', async () => {
    const { store } = createStore()
    await store.init()
    const { id } = await store.create('A')
    store.update(id, (draft) => void (draft.name = 'B'))
    await store.flush()
    const backup = `${paths.projectFile(id)}.bak`
    expect((JSON.parse(await readFile(backup, 'utf8')) as Project).name).toBe('A')
    store.update(id, (draft) => void (draft.name = 'C'))
    await store.flush()
    expect((JSON.parse(await readFile(backup, 'utf8')) as Project).name).toBe('B')
    expect((await readProjectFile(id)).name).toBe('C')
    expect((await readdir(paths.projectDir(id))).sort()).toEqual([
      'project.json',
      'project.json.bak'
    ])
  })

  it('leaves no temp link behind when project.json and the backup are one file', async () => {
    const { store } = createStore()
    await store.init()
    const { id } = await store.create('A')
    // the state after a save that failed past its backup step (e.g. the disk was full)
    const file = paths.projectFile(id)
    await link(file, `${file}.bak`)
    for (const name of ['B', 'C']) {
      store.update(id, (draft) => void (draft.name = name))
      await store.flush()
    }
    expect((await readdir(paths.projectDir(id))).sort()).toEqual([
      'project.json',
      'project.json.bak'
    ])
    expect((JSON.parse(await readFile(`${file}.bak`, 'utf8')) as Project).name).toBe('B')
  })

  it('restores a damaged project.json from the backup, writes it back and says so', async () => {
    const first = createStore()
    await first.store.init()
    const { id } = await first.store.create('Festival')
    first.store.update(id, (draft) => {
      draft.videos.push(makeVideo({ id: 'v1', durationSec: 60 }))
      draft.moments.push(makeMoment({ id: 'm1', videoId: 'v1', start: 1, end: 5, selected: true }))
    })
    await first.store.flush()
    first.store.update(id, (draft) => void (draft.name = 'Festival 2026'))
    await first.store.close()
    // power loss: the renamed file never got its data
    await writeFile(paths.projectFile(id), Buffer.alloc(4096))

    const notices: StoreNotice[] = []
    const { store, log } = createStore({ onNotice: (notice) => notices.push(notice) })
    await store.init()
    const restored = store.get(id)
    expect(restored).toMatchObject({ name: 'Festival', videos: [{ id: 'v1' }] })
    expect(restored.moments.map((m) => m.id)).toEqual(['m1'])
    expect(notices).toEqual([{ type: 'restored', projectId: id, name: 'Festival' }])
    expect(log.entries.some((e) => e.message.includes('restored from backup'))).toBe(true)

    await store.flush()
    expect(await readProjectFile(id)).toEqual(restored)
    // the backup still holds the good version, the damaged file is kept aside
    expect(
      (JSON.parse(await readFile(`${paths.projectFile(id)}.bak`, 'utf8')) as Project).name
    ).toBe('Festival')
    expect((await readdir(paths.projectDir(id))).sort()).toEqual([
      'project.json',
      'project.json.bak',
      'project.json.damaged'
    ])
  })

  it('leaves a project.json that cannot be read right now alone: the backup is older', async () => {
    const first = createStore()
    await first.store.init()
    const { id } = await first.store.create('Festival')
    first.store.update(id, (draft) => void (draft.name = 'Festival 2026'))
    await first.store.close()
    const file = paths.projectFile(id)
    const notices: StoreNotice[] = []
    const { store, log } = createStore({ onNotice: (notice) => notices.push(notice) })
    // a read error (here: no permission; the same goes for a disk error) says nothing about the content
    await chmod(file, 0o000)
    try {
      await store.init()
    } finally {
      await chmod(file, 0o644).catch(() => undefined)
    }
    // not opened – and not replaced by the backup with the older name
    expect(store.list()).toEqual([])
    expect(notices).toEqual([{ type: 'unreadable', count: 1 }])
    expect(log.entries.some((e) => e.level === 'error' && e.message.includes('skipped'))).toBe(true)
    expect((await readdir(paths.projectDir(id))).sort()).toEqual([
      'project.json',
      'project.json.bak'
    ])
    await store.close()
    // the next start opens the newest state
    const { store: reopened } = createStore()
    await reopened.init()
    expect(reopened.get(id).name).toBe('Festival 2026')
  })

  it('restores a project whose project.json is missing', async () => {
    const first = createStore()
    await first.store.init()
    const { id } = await first.store.create('Concert')
    first.store.update(id, (draft) => void (draft.name = 'Concert 2'))
    await first.store.close()
    await rm(paths.projectFile(id))
    const notices: StoreNotice[] = []
    const { store } = createStore({ onNotice: (notice) => notices.push(notice) })
    await store.init()
    expect(store.get(id).name).toBe('Concert')
    expect(notices).toEqual([{ type: 'restored', projectId: id, name: 'Concert' }])
  })

  it('starts with a project nested deep under a key it ignores: it and the others load', async () => {
    // the load compares the file with JSON.stringify (iterative in V8, also in Electron 45); the
    // normalised project keeps none of the nesting, so structuredClone in update() never sees it
    const depth = 100_000
    const nested = '['.repeat(depth) + ']'.repeat(depth)
    await writeRawProject(
      'deep',
      `${JSON.stringify(makeProject({ id: 'deep' })).slice(0, -1)},"x":${nested}}`
    )
    await writeRawProject('ok', makeProject({ id: 'ok' }))
    const notices: StoreNotice[] = []
    const { store } = createStore({ onNotice: (notice) => notices.push(notice) })
    await store.init()
    expect(store.list().map((s) => s.id)).toEqual(['deep', 'ok'])
    expect(notices).toEqual([])
    expect(store.update('deep', (draft) => void (draft.name = 'Renamed')).name).toBe('Renamed')
  })

  it('keeps a project folder that neither file can open and reports it', async () => {
    await writeRawProject('p1', '\0'.repeat(512))
    await writeFile(`${paths.projectFile('p1')}.bak`, '{"truncated": ')
    const media = paths.videoMediaDir('p1', 'v1')
    await mkdir(media, { recursive: true })
    await writeFile(join(media, 'proxy.mp4'), 'x')
    const notices: StoreNotice[] = []
    const { store, log } = createStore({ onNotice: (notice) => notices.push(notice) })
    await store.init()
    await store.flush()
    expect(store.list()).toEqual([])
    expect(notices).toEqual([{ type: 'unreadable', count: 1 }])
    expect(log.entries.some((e) => e.level === 'error' && e.message.includes('could not'))).toBe(
      true
    )
    // never deleted automatically
    expect(await pathExists(join(media, 'proxy.mp4'))).toBe(true)
    expect(await readFile(paths.projectFile('p1'), 'utf8')).toBe('\0'.repeat(512))
  })

  it('stays quiet about a folder without any project file', async () => {
    await mkdir(paths.projectDir('empty'), { recursive: true })
    const notices: StoreNotice[] = []
    const { store } = createStore({ onNotice: (notice) => notices.push(notice) })
    await store.init()
    expect(store.list()).toEqual([])
    expect(notices).toEqual([])
  })

  it('removes temp files of interrupted writes and export scratch folders', async () => {
    await writeRawProject('p1', makeProject({ id: 'p1' }))
    await writeFile(join(paths.projectDir('p1'), 'project.json.123.4.tmp'), '{')
    await mkdir(join(paths.exportWorkDir('p1', 'e1')), { recursive: true })
    const { store } = createStore()
    await store.init()
    expect(await readdir(paths.projectDir('p1'))).toEqual(['project.json'])
  })

  it('removes the half proxy of a run that was killed', async () => {
    await writeRawProject('p1', makeProject({ id: 'p1', videos: [makeVideo({ id: 'v1' })] }))
    const media = paths.videoMediaDir('p1', 'v1')
    await mkdir(media, { recursive: true })
    await writeFile(join(media, 'poster.jpg'), 'jpeg')
    const half = join(media, '.proxy.3fa2c1d0.part.mp4')
    await writeFile(half, 'half')
    const before = new Date(Date.now() - 5 * 60_000)
    await utimes(half, before, before)
    const { store } = createStore()
    await store.init()
    expect(await readdir(media)).toEqual(['poster.jpg'])
  })
})
