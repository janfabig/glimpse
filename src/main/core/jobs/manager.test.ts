import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../testing/harness'

let h: Harness | null = null

afterEach(async () => {
  await h?.dispose()
  h = null
})

describe('hasUnfinishedWork', () => {
  it('is true while an analysis or an export runs, not for previews alone', async () => {
    const harness = (h = await createHarness())
    const render = harness.media.hold('render')
    const { project } = await harness.preparedProject(['a.mp4'])
    expect(harness.jobs.hasUnfinishedWork()).toBe(false)

    const analysing = harness.analyzer.hold()
    await harness.jobs.startAnalysis(project.id)
    await analysing.reached
    expect(harness.jobs.hasUnfinishedWork()).toBe(true)
    analysing.release()
    await harness.jobs.whenIdle()
    expect(harness.jobs.hasUnfinishedWork()).toBe(false)

    harness.store.update(project.id, (draft) => {
      for (const moment of draft.moments) moment.selected = true
    })
    await harness.jobs.startExport(project.id)
    await render.reached
    expect(harness.jobs.hasUnfinishedWork()).toBe(true)
    render.release()
    await harness.jobs.whenIdle()
    expect(harness.jobs.hasUnfinishedWork()).toBe(false)

    // a preview that is still being built is redone after a restart: no reason to ask
    const proxy = harness.media.hold('proxy')
    await harness.jobs.addVideos(project.id, [await harness.video('b.mp4')])
    await proxy.reached
    expect(harness.jobs.hasUnfinishedWork()).toBe(false)
    proxy.release()
  })
})
