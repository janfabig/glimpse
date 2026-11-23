import { IPC_EVENTS } from '@shared/ipc'
import type { ExportProgress, Project, ToastEvent } from '@shared/types'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startCore, type CoreOptions, type CoreRuntime } from './runtime'
import { FakeAnalyzer } from './testing/fakeAnalyzer'
import { createFakeCipher } from './testing/fakeCipher'
import { FakeMedia } from './testing/fakeMedia'
import { eventually, makeTempDir, recordingLogger, type TempDir } from './testing/helpers'

let temp: TempDir
let core: CoreRuntime
let media: FakeMedia
let analyzer: FakeAnalyzer
let sent: { channel: string; payload: unknown }[]
let secrets: string[]
/** a fake of Electron's powerSaveBlocker: the ids it holds right now, and every type it was asked for */
let blocker: {
  held: Set<number>
  types: string[]
  start(type: string): number
  stop(id: number): boolean
}

function options(): CoreOptions {
  const log = Object.assign(recordingLogger(), { addSecret: (s: string) => void secrets.push(s) })
  return {
    userData: join(temp.path, 'userData'),
    videosDir: join(temp.path, 'Movies'),
    env: { GEMINI_API_KEY: 'env-key-123456' },
    media,
    analyzer,
    defaultModel: 'gemini-3.8-flash',
    cipher: createFakeCipher(),
    log,
    send: (channel, payload) => sent.push({ channel, payload }),
    powerSaveBlocker: blocker
  }
}

beforeEach(async () => {
  temp = await makeTempDir('hc-runtime-')
  sent = []
  secrets = []
  let nextId = 0
  blocker = {
    held: new Set(),
    types: [],
    start(type) {
      this.types.push(type)
      this.held.add(++nextId)
      return nextId
    },
    stop(id) {
      return this.held.delete(id)
    }
  }
  media = new FakeMedia()
  analyzer = new FakeAnalyzer()
  core = await startCore(options())
})

afterEach(async () => {
  await core.shutdown()
  await temp.cleanup()
})

function handlers(): ReturnType<CoreRuntime['createHandlers']> {
  return core.createHandlers({
    app: { version: '1.0.0', userDataDir: core.paths.userData },
    dialogs: { pickVideoFiles: async () => [], chooseDirectory: async () => null },
    shell: {
      showItemInFolder: () => undefined,
      openPath: async () => '',
      openExternal: async () => undefined
    }
  })
}

const updates = (projectId: string, list = sent): Project[] =>
  list
    .filter((s) => s.channel === IPC_EVENTS.projectUpdated)
    .map((s) => s.payload as Project)
    .filter((project) => project.id === projectId)

const toasts = (list = sent): ToastEvent[] =>
  list.filter((s) => s.channel === IPC_EVENTS.toast).map((s) => s.payload as ToastEvent)

const stagesOf = (project: Project | undefined): string[] =>
  project ? project.videos.map((v) => project.status[v.id].analysis.stage) : []

/** a project with prepared videos; the renderer has called in (toasts are delivered) */
async function preparedProject(names: string[]): Promise<Project> {
  const api = handlers()
  const project = await api.createProject('Live')
  const dir = join(temp.path, 'Originals')
  await mkdir(dir, { recursive: true })
  const files = await Promise.all(
    names.map(async (name) => {
      const path = join(dir, name)
      await writeFile(path, `video data of ${name}`)
      return path
    })
  )
  // as if picked in the dialog: addVideos reads only handed-over files
  core.jobs.grantPaths(files)
  await api.addVideos(project.id, files)
  await eventually(() => {
    const current = core.store.get(project.id)
    expect(current.videos.every((v) => current.status[v.id].prepare.status === 'done')).toBe(true)
  })
  return core.store.get(project.id)
}

describe('startCore', () => {
  it('wires settings defaults, the env key and log redaction', async () => {
    const settings = await handlers().getSettings()
    expect(settings).toMatchObject({
      model: 'gemini-3.8-flash',
      apiKeySource: 'env',
      defaultOutputDir: join(temp.path, 'Movies', 'Glimpse')
    })
    expect(secrets).toContain('env-key-123456')
  })

  it('broadcasts project changes and flushes them on shutdown', async () => {
    const api = handlers()
    const project = await api.createProject('Live')
    await api.mutateProject(project.id, { type: 'rename', name: 'Live 2' })
    await eventually(() =>
      expect(
        sent
          .filter((s) => s.channel === IPC_EVENTS.projectUpdated)
          .map((s) => (s.payload as { name: string }).name)
      ).toContain('Live 2')
    )
    await core.shutdown()
    const saved = JSON.parse(await readFile(core.paths.projectFile(project.id), 'utf8')) as {
      name: string
    }
    expect(saved.name).toBe('Live 2')
  })

  it('allows media below the projects folder and known originals only', async () => {
    expect(core.isMediaAllowed(core.paths.proxyFile('p1', 'v1'))).toBe(true)
    expect(core.isMediaAllowed(core.paths.settingsFile)).toBe(false)
    expect(core.isMediaAllowed('/Users/jan/Movies/clip.mp4')).toBe(false)
  })

  it('reports the log file in the app info', async () => {
    expect(await handlers().getAppInfo()).toMatchObject({ logFile: core.paths.logFile })
  })
})

describe('job state reaches the renderer in order', () => {
  it('publishes the queued videos before startAnalysis resolves', async () => {
    const api = handlers()
    const project = await preparedProject(['a.mp4', 'b.mp4'])
    // an update right before the start keeps the project throttle busy
    await api.mutateProject(project.id, { type: 'rename', name: 'Live 2' })
    await api.startAnalysis(project.id)
    const before = sent.slice()
    expect(updates(project.id, before).map((p) => stagesOf(p).join())).toContain('queued,queued')
    await core.jobs.whenIdle()
  })

  it('sends the automatically selected reel before the completion toast', async () => {
    const api = handlers()
    const project = await preparedProject(['a.mp4', 'b.mp4'])
    await api.startAnalysis(project.id)
    await core.jobs.whenIdle()
    const index = sent.findIndex(
      (s) =>
        s.channel === IPC_EVENTS.toast &&
        (s.payload as ToastEvent).message.startsWith('Analysis done')
    )
    expect(index).toBeGreaterThan(0)
    const last = updates(project.id, sent.slice(0, index)).at(-1)
    expect(stagesOf(last)).toEqual(['done', 'done'])
    expect(last?.moments.some((m) => m.selected)).toBe(true)
  })

  it('sends the project with its new export record before the "done" event', async () => {
    const api = handlers()
    const project = await preparedProject(['a.mp4'])
    await api.startAnalysis(project.id)
    await core.jobs.whenIdle()
    const gate = media.hold('render')
    const { exportId } = await api.startExport(project.id)
    await gate.reached
    // an update shortly before the end keeps the project throttle busy
    await api.mutateProject(project.id, { type: 'rename', name: 'Live 3' })
    gate.release()
    await core.jobs.whenIdle()
    const index = sent.findIndex(
      (s) =>
        s.channel === IPC_EVENTS.exportProgress && (s.payload as ExportProgress).phase === 'done'
    )
    expect(index).toBeGreaterThan(0)
    const last = updates(project.id, sent.slice(0, index)).at(-1)
    expect(last?.exports.map((record) => record.id)).toEqual([exportId])
  })
})

describe('sleep while jobs run', () => {
  it('keeps the Mac awake (the display may sleep) exactly while a job runs', async () => {
    const api = handlers()
    const project = await preparedProject(['a.mp4'])
    await api.startAnalysis(project.id)
    await core.jobs.whenIdle()
    expect(blocker.held.size).toBe(0)
    const gate = media.hold('render')
    await api.startExport(project.id)
    await gate.reached
    expect(blocker.held.size).toBe(1)
    gate.release()
    await core.jobs.whenIdle()
    expect(blocker.held.size).toBe(0)
    expect(new Set(blocker.types)).toEqual(new Set(['prevent-app-suspension']))
  })
})

describe('quitting', () => {
  it('starts no new work once the shutdown has begun – its ffmpeg would outlive the app', async () => {
    const api = handlers()
    const project = await preparedProject(['a.mp4'])
    await api.startAnalysis(project.id)
    await core.jobs.whenIdle()
    const later = join(temp.path, 'Originals', 'later.mp4')
    await writeFile(later, 'video data of later.mp4')
    const videoId = project.videos[0].id
    const before = structuredClone(media.calls)

    const stopping = core.shutdown()
    // an edit is still taken and saved
    await api.mutateProject(project.id, { type: 'rename', name: 'Live 2' })
    // a click in the seconds the shutdown waits for the cancelled jobs
    const refused = { code: 'busy', userMessage: 'Glimpse is quitting.' }
    await expect(api.startExport(project.id)).rejects.toMatchObject(refused)
    await expect(api.startAnalysis(project.id, { force: true })).rejects.toMatchObject(refused)
    await expect(api.analyzeAgain(project.id, 'more crowd')).rejects.toMatchObject(refused)
    await expect(api.addVideos(project.id, [later])).rejects.toMatchObject(refused)
    await expect(api.retryPrepare(project.id, videoId)).rejects.toMatchObject(refused)
    await expect(api.openProject(project.id)).rejects.toMatchObject(refused)
    await stopping

    expect(media.calls).toEqual(before)
    const saved = JSON.parse(await readFile(core.paths.projectFile(project.id), 'utf8')) as Project
    expect(saved.name).toBe('Live 2')
    expect(saved.videos.map((v) => v.fileName)).toEqual(['a.mp4'])
  })
})

describe('notices about the project files', () => {
  it('warns once when saving fails and confirms when everything is saved again', async () => {
    const api = handlers()
    const project = await api.createProject('Live')
    await chmod(core.paths.projectDir(project.id), 0o500)
    try {
      await api.mutateProject(project.id, { type: 'rename', name: 'Live 2' })
      await eventually(() => expect(toasts().map((t) => t.level)).toEqual(['warning']))
    } finally {
      await chmod(core.paths.projectDir(project.id), 0o755)
    }
    await core.store.flush()
    // the warning stays until the recovery toast with the same key replaces it
    expect(toasts()).toEqual([
      {
        level: 'warning',
        message:
          'Your changes cannot be saved right now. Is the disk full? As soon as there is space ' +
          'again, the app goes on saving by itself.',
        sticky: true,
        key: 'project-save'
      },
      { level: 'success', message: 'Everything is saved again.', key: 'project-save' }
    ])
  })

  it('keeps the toasts of the start until the renderer has called in', async () => {
    const api = handlers()
    const project = await api.createProject('Festival')
    await api.mutateProject(project.id, { type: 'rename', name: 'Festival 2' })
    await core.shutdown()
    await writeFile(core.paths.projectFile(project.id), Buffer.alloc(1024))

    sent = []
    core = await startCore(options())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(toasts()).toEqual([])
    const listed = await handlers().listProjects()
    expect(listed.map((summary) => summary.name)).toEqual(['Festival'])
    expect(toasts()).toEqual([
      {
        level: 'warning',
        message:
          '“Festival” was damaged and was restored from the last backup. The latest changes ' +
          'may be missing.',
        sticky: true
      }
    ])
  })
})
