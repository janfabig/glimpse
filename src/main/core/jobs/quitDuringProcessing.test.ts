// Core + the real Gemini analyzer (fake SDK client and upload server, no network): quitting while
// Gemini still processes an upload waits for that upload's delete. Core never heard of the upload
// (it is reported once ACTIVE) – the analyzer hands the delete over through onCleanup.

import { FileState } from '@google/genai'
import { afterEach, describe, expect, it } from 'vitest'
import { createGeminiAnalyzer } from '../../ai/gemini'
import {
  activeFile,
  fakeClient,
  recordingLogger as aiLogger,
  UPLOAD_BASE,
  uploadServer
} from '../../ai/testSupport'
import { CHUNK_GRANULARITY } from '../../ai/upload'
import { createHarness, type Harness } from '../testing/harness'
import { eventually } from '../testing/helpers'
import { JobManager } from './manager'

let h: Harness | null = null

afterEach(async () => {
  await h?.dispose()
  h = null
})

describe('quitting while Gemini processes an upload', () => {
  it('waits for the delete of that upload', async () => {
    const harness = (h = await createHarness())
    const { project } = await harness.preparedProject(['a.mp4'])
    const deletes: { name: string; done: boolean }[] = []
    const client = fakeClient({
      // Gemini is still processing the video
      getFile: (name) => activeFile({ name, state: FileState.PROCESSING }),
      deleteFile: async (name) => {
        const entry = { name, done: false }
        deletes.push(entry)
        // a slow request on festival Wi-Fi
        await new Promise((resolve) => setTimeout(resolve, 300))
        entry.done = true
        return {}
      }
    })
    const server = uploadServer({ file: { name: 'files/up1', state: FileState.PROCESSING } })
    const jobs = new JobManager({
      store: harness.store,
      settings: harness.settings,
      media: harness.media,
      analyzer: createGeminiAnalyzer({
        createClient: () => client,
        fetch: server.fetch,
        logger: aiLogger(),
        uploadBaseUrl: UPLOAD_BASE,
        chunkSize: CHUNK_GRANULARITY,
        pollIntervalMs: 20
      }),
      paths: harness.paths,
      log: harness.log,
      disk: harness.disk,
      notify: { toast: () => undefined, exportProgress: () => undefined, flushProject: () => {} }
    })
    await jobs.startAnalysis(project.id)
    await eventually(() => {
      const current = harness.store.get(project.id)
      expect(current.status[current.videos[0].id].analysis.stage).toBe('processing')
    })

    // what CoreRuntime.shutdown() does before the app quits
    jobs.cancelAll()
    expect(await jobs.whenIdle(5000)).toBe(true)
    expect(deletes).toEqual([{ name: 'files/up1', done: true }])
    expect(harness.store.get(project.id).remoteFiles).toEqual({})
  })
})
