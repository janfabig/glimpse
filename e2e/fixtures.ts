// Playwright fixtures: `hc` is a fresh app on a fresh profile per test, `videos` the cached test clips.

import { test as base, expect } from '@playwright/test'
import { HcApp } from './support/app'
import { ensureVideos, type TestVideoSet } from './support/media'

interface TestFixtures {
  /**
   * extra environment for this test's app, e.g. `test.use({ appEnv: { HC_FAKE_AI_REQUIRE_KEY: '1' } })`
   * (applies to every launch of the test; the E2E basics such as HC_E2E cannot be overridden)
   */
  appEnv: Record<string, string>
  hc: HcApp
}

interface WorkerFixtures {
  videos: TestVideoSet
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  videos: [
    // eslint-disable-next-line no-empty-pattern -- Playwright needs the destructuring pattern
    async ({}, provide) => {
      await provide(await ensureVideos())
    },
    { scope: 'worker', timeout: 10 * 60_000 }
  ],

  appEnv: [{}, { option: true }],

  hc: async ({ appEnv }, provide, testInfo) => {
    const hc = await HcApp.create({ env: appEnv })
    let problems: string[] = []
    try {
      // inside try: a failed start is cleaned up as well
      await hc.launch()
      await provide(hc)
      problems = hc.unexpectedConsoleProblems()
    } finally {
      await hc.dispose(testInfo, problems.length > 0)
    }
    // React errors, failed loads etc. in the renderer fail the test
    expect(problems, 'unexpected renderer console errors').toEqual([])
  }
})

export { expect }
