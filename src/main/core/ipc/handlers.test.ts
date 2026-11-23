import { IPC, parseIpcError } from '@shared/ipc'
import type { AppSettings, SettingsPatch } from '@shared/types'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnalyzerError } from '../../contracts'
import { JOB_MESSAGES } from '../jobs/messages'
import { DEFAULT_PROJECT_NAME } from '../project/defaults'
import { createHarness, TEST_API_KEY, type Harness } from '../testing/harness'
import { createIpcHandlers, IPC_MESSAGES, type IpcHandlers } from './handlers'

let h: Harness
let handlers: IpcHandlers
let patches: SettingsPatch[]
let secrets: string[]
let shellCalls: { method: string; arg: string }[]
let openPathResult: string

beforeEach(async () => {
  h = await createHarness()
  patches = []
  secrets = []
  shellCalls = []
  openPathResult = ''
  handlers = createIpcHandlers({
    settings: {
      getAppSettings: () => h.settings.getAppSettings(),
      getApiKey: () => h.settings.getApiKey(),
      update: async (patch): Promise<AppSettings> => {
        patches.push(patch)
        return h.settings.getAppSettings()
      },
      reportKeyCheck: (apiKey, accepted) => h.settings.reportKeyCheck(apiKey, accepted)
    },
    store: h.store,
    jobs: h.jobs,
    media: h.media,
    analyzer: h.analyzer,
    app: { version: '0.1.0', userDataDir: h.paths.userData, logFile: h.paths.logFile },
    dialogs: {
      pickVideoFiles: async () => ['/Users/jan/Movies/a.mp4'],
      chooseDirectory: async () => null
    },
    shell: {
      showItemInFolder: (path) => void shellCalls.push({ method: 'showItemInFolder', arg: path }),
      openPath: async (path) => {
        shellCalls.push({ method: 'openPath', arg: path })
        return openPathResult
      },
      openExternal: async (url) => void shellCalls.push({ method: 'openExternal', arg: url })
    },
    log: h.log,
    onSecret: (secret) => secrets.push(secret)
  })
})

afterEach(async () => {
  await h.dispose()
})

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    return parseIpcError(err).code
  }
  throw new Error('expected a rejection')
}

describe('IPC handlers', () => {
  it('cover every invoke channel', () => {
    expect(Object.keys(handlers).sort()).toEqual(Object.keys(IPC).sort())
  })

  it('report app info without secrets', async () => {
    const info = await handlers.getAppInfo()
    expect(info).toEqual({
      version: '0.1.0',
      ffmpeg: await h.media.status(),
      userDataDir: h.paths.userData,
      logFile: h.paths.logFile
    })
    expect(JSON.stringify(await handlers.getSettings())).not.toContain(TEST_API_KEY)
  })

  it('pass only known settings fields on', async () => {
    await handlers.updateSettings({ model: 'gemini-test', evil: true, apiKey: undefined })
    expect(patches).toEqual([{ model: 'gemini-test' }])
    expect(await codeOf(handlers.updateSettings('nope'))).toBe('invalid')
  })

  it('create, list, open and mutate projects', async () => {
    const created = await handlers.createProject()
    expect(created.name).toBe(DEFAULT_PROJECT_NAME)
    const named = await handlers.createProject('  Summer  ')
    expect(named.name).toBe('Summer')
    expect((await handlers.listProjects()).map((s) => s.id).sort()).toEqual(
      [created.id, named.id].sort()
    )
    expect((await handlers.openProject(named.id)).id).toBe(named.id)

    const renamed = await handlers.mutateProject(named.id, { type: 'rename', name: 'Winter' })
    expect(renamed.name).toBe('Winter')
    expect(h.store.get(named.id).name).toBe('Winter')
  })

  it('validate ids and payloads before doing anything', async () => {
    const { id } = await handlers.createProject()
    expect(await codeOf(handlers.openProject('../etc'))).toBe('invalid')
    expect(await codeOf(handlers.openProject(42))).toBe('invalid')
    expect(await codeOf(handlers.openProject('unknown'))).toBe('not-found')
    expect(await codeOf(handlers.createProject({ name: 'x' }))).toBe('invalid')
    expect(await codeOf(handlers.mutateProject(id, { type: 7 }))).toBe('invalid')
    expect(await codeOf(handlers.mutateProject(id, { type: 'rename', name: '' }))).toBe('invalid')
    expect(await codeOf(handlers.addVideos(id, '/a.mp4'))).toBe('invalid')
    expect(await codeOf(handlers.addVideos(id, ['/a\0.mp4']))).toBe('invalid')
    expect(await codeOf(handlers.removeVideo(id, '../x'))).toBe('invalid')
    // on a project that could start, so only the validator can reject it
    const { project } = await h.preparedProject(['a.mp4'])
    expect(await codeOf(handlers.startAnalysis(project.id, { force: 'yes' }))).toBe('invalid')
    expect(await codeOf(handlers.analyzeAgain(project.id, '   '))).toBe('invalid')
    expect(await codeOf(handlers.analyzeAgain(project.id, { wish: 'More crowd.' }))).toBe('invalid')
    expect(await codeOf(handlers.analyzeAgain('../etc', 'More crowd.'))).toBe('invalid')
    expect(h.store.get(project.id).brief).toEqual(project.brief)
    expect(h.analyzer.calls).toEqual([])
  })

  it('start a second pass in one step: the wish joins the brief, every video is analysed again', async () => {
    const { project } = await h.preparedProject(['a.mp4', 'b.mp4'])
    await handlers.startAnalysis(project.id)
    await h.jobs.whenIdle()
    await handlers.analyzeAgain(project.id, '  More crowd. ')
    await h.jobs.whenIdle()
    expect(h.store.get(project.id).brief.prompt).toBe(`${project.brief.prompt}\nMore crowd.`)
    const second = h.analyzer.calls.slice(2)
    expect(second.map((call) => call.video.fileName).sort()).toEqual(['a.mp4', 'b.mp4'])
    for (const call of second) expect(call.earlierClips).toHaveLength(3)
  })

  it('run the job methods', async () => {
    const { project, videoIds } = await h.preparedProject(['a.mp4'])
    await handlers.startAnalysis(project.id, { videoIds })
    await h.jobs.whenIdle()
    const selected = await handlers.autoSelect(project.id)
    expect(selected.moments.some((m) => m.selected)).toBe(true)
    const { exportId } = await handlers.startExport(project.id)
    expect(exportId).toMatch(/^id\d+$/)
    await h.jobs.whenIdle()
    await handlers.cancelAnalysis(project.id)
    await handlers.cancelExport(project.id)
    const removed = await handlers.removeVideo(project.id, videoIds[0])
    expect(removed.videos).toEqual([])
    await handlers.deleteProject(project.id)
    expect(await codeOf(handlers.openProject(project.id))).toBe('not-found')
  })
})

describe('API key handlers', () => {
  it('tests a typed key and registers it for log redaction', async () => {
    const result = await handlers.testApiKey(' AIzaTyped ')
    expect(result.ok).toBe(true)
    expect(secrets).toEqual(['AIzaTyped'])
    expect((await handlers.testApiKey('bad-key')).ok).toBe(false)
  })

  it('tests the stored key when none is given', async () => {
    expect((await handlers.testApiKey()).ok).toBe(true)
    h.settings.apiKey = null
    expect(await handlers.testApiKey()).toEqual({ ok: false, message: IPC_MESSAGES.noStoredKey })
  })

  it("passes Google's verdict about a key on to the settings (apiKeyRejected)", async () => {
    await handlers.testApiKey()
    await handlers.testApiKey('bad-key')
    // a failed test that says nothing about the key itself is no verdict
    h.analyzer.testKey = async () => ({ ok: false, message: 'No connection to Google.' })
    await handlers.testApiKey()
    expect(h.settings.keyChecks).toEqual([
      { apiKey: TEST_API_KEY, accepted: true },
      { apiKey: 'bad-key', accepted: false }
    ])
  })

  it('turns analyzer errors into a failed test result', async () => {
    h.analyzer.testKey = async () => {
      throw new AnalyzerError('network', 'No connection to Google.')
    }
    expect(await handlers.testApiKey('AIzaTyped')).toEqual({
      ok: false,
      message: 'No connection to Google.'
    })
    h.analyzer.testKey = async () => {
      throw new Error('socket hang up')
    }
    expect(await handlers.testApiKey('AIzaTyped')).toEqual({
      ok: false,
      message: IPC_MESSAGES.keyTestFailed
    })
  })

  it('lists models only with a key (or the fake analyzer)', async () => {
    expect(await handlers.listModels()).toHaveLength(1)
    h.settings.apiKey = null
    expect(await codeOf(handlers.listModels())).toBe('no-api-key')
    h.settings.settings = { ...h.settings.settings, fakeAi: true }
    expect(await handlers.listModels()).toHaveLength(1)
  })

  it('say so when the stored key cannot be read any more', async () => {
    h.settings.apiKey = null
    h.settings.settings = {
      ...h.settings.settings,
      hasApiKey: false,
      apiKeySource: null,
      apiKeyUnreadable: true
    }
    expect(await handlers.testApiKey()).toEqual({
      ok: false,
      message: JOB_MESSAGES.apiKeyUnreadable
    })
    let error: unknown
    await handlers.listModels().catch((err: unknown) => (error = err))
    expect(parseIpcError(error)).toEqual({
      code: 'no-api-key',
      message: JOB_MESSAGES.apiKeyUnreadable
    })
    // a typed key is tested as usual
    expect((await handlers.testApiKey('AIzaTyped')).ok).toBe(true)
  })
})

describe('shell handlers', () => {
  async function exportedFile(): Promise<{ projectId: string; path: string }> {
    const project = await h.store.create('A')
    const path = join(h.outputDir, 'A – Highlights.mp4')
    await mkdir(h.outputDir, { recursive: true })
    await writeFile(path, 'video')
    h.store.update(project.id, (draft) => {
      draft.exports.push({
        id: 'e1',
        path,
        createdAt: draft.createdAt,
        durationSec: 30,
        clipCount: 3,
        sizeBytes: 5
      })
    })
    return { projectId: project.id, path }
  }

  it('open only exports – originals go through openOriginal', async () => {
    const { path } = await exportedFile()
    await handlers.openFile(path)
    expect(shellCalls).toEqual([{ method: 'openPath', arg: path }])
    const { files } = await h.preparedProject(['a.mp4'])
    expect(await codeOf(handlers.openFile(files[0]))).toBe('invalid')
    expect(await codeOf(handlers.openFile('/Applications/Calculator.app'))).toBe('invalid')
    expect(await codeOf(handlers.openFile('relative.mp4'))).toBe('invalid')
    openPathResult = 'No application knows how to open this'
    expect(await codeOf(handlers.openFile(path))).toBe('internal')
  })

  it('play an original by its project and video id – main looks the path up itself', async () => {
    const { project, files } = await h.preparedProject(['a.mp4'])
    const [video] = project.videos
    await handlers.openOriginal(project.id, video.id)
    expect(shellCalls).toEqual([{ method: 'openPath', arg: files[0] }])
    expect(await codeOf(handlers.openOriginal(project.id, files[0]))).toBe('invalid')
    expect(await codeOf(handlers.openOriginal('../etc', video.id))).toBe('invalid')
    expect(await codeOf(handlers.openOriginal('unknown', video.id))).toBe('not-found')
    expect(await codeOf(handlers.openOriginal(project.id, 'unknown'))).toBe('not-found')
    openPathResult = 'No application knows how to open this'
    expect(await codeOf(handlers.openOriginal(project.id, video.id))).toBe('internal')

    const { rm } = await import('node:fs/promises')
    await rm(files[0])
    const missing = await handlers.openOriginal(project.id, video.id).catch(parseIpcError)
    expect(missing).toEqual({ code: 'not-found', message: JOB_MESSAGES.missingOriginal('a.mp4') })
    expect(shellCalls).toHaveLength(2)
  })

  it('report exports that were deleted meanwhile', async () => {
    const { path } = await exportedFile()
    const { rm } = await import('node:fs/promises')
    await rm(path)
    expect(await codeOf(handlers.openFile(path))).toBe('not-found')
    expect(await codeOf(handlers.showInFinder(path))).toBe('not-found')
  })

  it('reveal exports and the output folder, nothing else', async () => {
    const { path } = await exportedFile()
    await handlers.showInFinder(path)
    await handlers.showInFinder(h.outputDir)
    expect(shellCalls.map((c) => c.arg)).toEqual([path, h.outputDir])
    expect(await codeOf(handlers.showInFinder('/etc/hosts'))).toBe('invalid')
    expect(await codeOf(handlers.showInFinder(h.paths.apiKeyFile))).toBe('invalid')
  })

  it('reveal the log file (Settings → System), but nothing else of the profile', async () => {
    await mkdir(h.paths.logsDir, { recursive: true })
    await writeFile(h.paths.logFile, 'log line\n')
    await writeFile(join(h.paths.logsDir, 'main.1.log'), 'older\n')
    await handlers.showInFinder(h.paths.logFile)
    await handlers.showInFinder(join(h.paths.logsDir, '.', 'main.log'))
    expect(shellCalls.map((c) => c.arg)).toEqual([h.paths.logFile, h.paths.logFile])
    expect(await codeOf(handlers.showInFinder(join(h.paths.logsDir, 'main.1.log')))).toBe('invalid')
    expect(await codeOf(handlers.showInFinder(h.paths.logsDir))).toBe('invalid')
    expect(await codeOf(handlers.openFile(h.paths.logFile))).toBe('invalid')
  })

  it('open only allow-listed links', async () => {
    await handlers.openExternal('https://aistudio.google.com/apikey')
    expect(shellCalls).toEqual([
      { method: 'openExternal', arg: 'https://aistudio.google.com/apikey' }
    ])
    expect(await codeOf(handlers.openExternal('https://evil.example/'))).toBe('invalid')
    expect(await codeOf(handlers.openExternal(42))).toBe('invalid')
  })

  it('pass dialog results through', async () => {
    expect(await handlers.pickVideoFiles()).toEqual(['/Users/jan/Movies/a.mp4'])
    expect(await handlers.chooseOutputDir()).toBeNull()
  })

  it('let addVideos list a folder only once the user picked it in the dialog', async () => {
    const { id } = await handlers.createProject()
    const folder = join(h.temp.path, 'Festival Saturday')
    await mkdir(folder)
    await writeFile(join(folder, 'Stage.mp4'), 'video data')
    expect((await handlers.addVideos(id, [folder])).added).toBe(0)

    const picking = createIpcHandlers({
      settings: { ...h.settings, update: async () => h.settings.getAppSettings() },
      store: h.store,
      jobs: h.jobs,
      media: h.media,
      analyzer: h.analyzer,
      app: { version: '0.1.0', userDataDir: h.paths.userData, logFile: h.paths.logFile },
      dialogs: { pickVideoFiles: async () => [folder], chooseDirectory: async () => null },
      shell: {
        showItemInFolder: () => undefined,
        openPath: async () => '',
        openExternal: async () => undefined
      },
      log: h.log
    })
    expect(await picking.pickVideoFiles()).toEqual([folder])
    expect((await handlers.addVideos(id, [folder])).added).toBe(1)
  })
})
