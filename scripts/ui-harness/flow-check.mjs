#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS script */
// Clicks through the whole user flow against the mock API (offscreen) and fails on any console
// error: new project → import → brief → analysis → review edits → export → settings. Also guards
// against regressions: double clicks (also on remove buttons whose list reflows under the
// pointer), clicks, drags and quick flicks on the trim handles, the trim keys, holding −/+, edits
// that change nothing, the clip loop after I and after a trim, ↓ after X (both tabs), editing
// during the preview, the preview ending when a clip leaves the reel, two quick clicks on a
// chevron, "Undo" after a row's ✕ (its toast clear of the timeline) and none
// after X, the clip and tab kept across steps (clip 1 once that clip is gone), the preview from
// the clip before the active one, "More suggestions" best first and at most 10 (also for ↓),
// re-analysis confirmation, keyboard focus kept inside dialogs, a chosen export option that looks
// chosen under the pointer, a finished export that no longer matches the reel, a double click on a
// video's poster and the 10 rows of "More suggestions" in a project with more clips to suggest.
// And ↑/↓ on a tab the shown clip is not listed on: they start at its top row.
// Usage: node scripts/ui-harness/flow-check.mjs [--no-build] [--shots]
//        --shots writes a screenshot per step to artifacts/ui/flow/

import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import electronPath from 'electron'
import { _electron as electron } from '@playwright/test'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '../..')
const buildDir = resolve(root, '.cache/ui-build')
const shotDir = resolve(root, 'artifacts/ui/flow')
const { values } = parseArgs({
  options: {
    'no-build': { type: 'boolean', default: false },
    shots: { type: 'boolean', default: false }
  }
})

if (!values['no-build'])
  await build({ configFile: resolve(import.meta.dirname, 'vite.config.mjs') })
if (values.shots) {
  // numbering changes with the flow; never mix in shots of an older run
  await rm(shotDir, { recursive: true, force: true })
  await mkdir(shotDir, { recursive: true })
}

const app = await electron.launch({
  executablePath: electronPath,
  args: [resolve(import.meta.dirname, 'main.mjs')],
  env: {
    ...process.env,
    UI_BUILD_DIR: buildDir,
    UI_WIDTH: '1440',
    UI_HEIGHT: '900',
    UI_SCENARIO: 'home'
  }
})
const problems = []
let shot = 0

try {
  const page = await app.firstWindow()
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  const id = (testId) => page.getByTestId(testId)
  const step = async (name) => {
    console.log(`• ${name}`)
    if (values.shots)
      await page.screenshot({
        path: resolve(shotDir, `${String(++shot).padStart(2, '0')}-${name}.png`)
      })
  }

  const url = pathToFileURL(resolve(buildDir, 'index.html'))
  url.search = '?mock=1&scenario=home&snap=1'
  await page.goto(url.href)
  await page.waitForSelector('body[data-ready="true"]')
  await step('home')
  const projectsBefore = await page.locator('[data-testid="project-card"]').count()

  // new project + import (the mock's file picker returns three videos); double clicks must not
  // create a second project or open the picker twice
  await id('new-project').dblclick()
  await page.waitForSelector('[data-screen="videos"]')
  await id('add-videos').dblclick()
  await page.waitForSelector('[data-testid="video-importing"]')
  await step('videos-importing')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="video-card"]').length === 3
  )
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="video-card"][data-prepare="done"]').length === 3,
    undefined,
    { timeout: 20_000 }
  )
  if ((await page.locator('[data-testid="video-card"]').count()) !== 3) {
    throw new Error('the file picker ran twice')
  }
  // three more videos; then a double click on a card's X – or two quick clicks on the same spot –
  // removes that video only, not the next one, which slides into its place right away
  await id('add-videos').click()
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="video-card"]').length === 6,
    undefined,
    { timeout: 15_000 }
  )
  const cards = page.locator('[data-testid="video-card"]')
  await cards.first().hover()
  await cards.first().getByTestId('remove-video').dblclick()
  await page.waitForTimeout(600)
  if ((await cards.count()) !== 5) {
    throw new Error(`double click on X left ${await cards.count()} of 6 videos`)
  }
  await cards.first().hover()
  const removeBox = await cards.first().getByTestId('remove-video').boundingBox()
  const removeAt = [removeBox.x + removeBox.width / 2, removeBox.y + removeBox.height / 2]
  await page.mouse.click(...removeAt)
  await page.waitForTimeout(150)
  await page.mouse.click(...removeAt)
  await page.waitForTimeout(600)
  if ((await cards.count()) !== 4) {
    throw new Error(`two quick clicks on X left ${await cards.count()} of 5 videos`)
  }
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="video-card"][data-prepare="done"]').length === 4,
    undefined,
    { timeout: 30_000 }
  )
  // a double click on a poster opens the original once
  await cards.first().getByTestId('video-play').dblclick()
  const playing = page.locator('[data-testid="toast"]', { hasText: 'would now be played' })
  await playing.first().waitFor()
  await page.waitForTimeout(300)
  if ((await playing.count()) !== 1) {
    throw new Error(`a double click on a poster opened the original ${await playing.count()} times`)
  }
  await playing.getByRole('button', { name: 'Dismiss' }).click()
  await id('project-name').click()
  await page.keyboard.press('Meta+A')
  await page.keyboard.type('Test run festival')
  await page.keyboard.press('Enter')
  await page.getByText('Test run festival').first().waitFor()
  // Escape throws the typed name away
  await id('project-name').click()
  await page.keyboard.press('Meta+A')
  await page.keyboard.type('Discarded')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  if ((await id('project-name').textContent()) !== 'Test run festival') {
    throw new Error(`Escape renamed the project to "${await id('project-name').textContent()}"`)
  }
  await id('next-step').click()

  // brief
  await page.waitForSelector('[data-screen="brief"]')
  await id('target-90').click()
  await id('brief-prompt').fill('Show the best music moments and leave out the breaks.')
  await step('brief')
  await id('start-analysis').click()

  // analysis
  await page.waitForSelector('[data-screen="analysis"]')
  await step('analysis-running')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="analysis-row"][data-stage="done"]').length === 4,
    undefined,
    { timeout: 40_000 }
  )
  await page.locator('[data-testid="go-review"]:not([disabled])').waitFor()
  await step('analysis-done')
  await id('go-review').click()

  // review
  await page.waitForSelector('[data-screen="review"]')
  // trim handles: a click without moving changes nothing – same times, and the automatic reel stays
  // automatic ("Auto-select" does not ask first); a quick flick (down, then one move and
  // the release in the same frame) moves the edge and is saved, so now it asks
  const edges = async (scope) => [
    Number(await scope.getByTestId('handle-in').getAttribute('aria-valuenow')),
    Number(await scope.getByTestId('handle-out').getAttribute('aria-valuenow'))
  ]
  // the playhead as the transport bar shows it ("2:06,5 / 4:58")
  const playhead = async (scope) => {
    const [m, s] = (await scope.locator('.transport__time').innerText())
      .split(' ')[0]
      .replace(',', '.')
      .split(':')
      .map(Number)
    return m * 60 + s
  }
  // , . move the start and - + (= on US keyboards) the end by 0.5 s, a held key keeps trimming,
  // and each edit seeks to where it can be heard: the new start, or 2 s before the new end
  const trimKeys = async (scope) => {
    for (const [key, edge, delta, presses] of [
      ['.', 0, 0.5, 1],
      [',', 0, -0.5, 1],
      ['-', 1, -0.5, 1],
      ['+', 1, 0.5, 1],
      ['=', 1, 0.5, 1],
      ['-', 1, -0.5, 4]
    ]) {
      const before = await edges(scope)
      // keyboard.down while the key is down sends auto-repeat events
      for (let i = 0; i < presses; i++) await page.keyboard.down(key)
      await page.keyboard.up(key)
      await page.waitForTimeout(200)
      const after = await edges(scope)
      const heard = edge ? Math.max(after[0], after[1] - 2) : after[0]
      const time = await playhead(scope)
      if (
        Math.abs(after[edge] - before[edge] - presses * delta) > 0.01 ||
        Math.abs(time - heard) > 0.11
      ) {
        throw new Error(
          `${presses}× "${key}": ${before} → ${after}, playhead ${time}, not ${heard}`
        )
      }
    }
  }
  const autoSelectAsks = async () => {
    await id('auto-select').click()
    await page.waitForTimeout(400)
    if ((await id('confirm-dialog').count()) === 0) return false
    await id('confirm-dialog').getByRole('button', { name: 'Cancel' }).click()
    await id('confirm-dialog').waitFor({ state: 'detached' })
    return true
  }
  const clipEdges = await edges(page)
  await id('handle-in').click()
  await id('handle-out').click()
  // neither does I on the start (a click on the start handle puts the playhead there)
  await id('handle-in').click()
  await page.keyboard.press('i')
  await page.waitForTimeout(300)
  if ((await edges(page)).join() !== clipEdges.join()) {
    throw new Error(
      `a click on the trim handles moved the clip: ${clipEdges} → ${await edges(page)}`
    )
  }
  if (await autoSelectAsks()) {
    throw new Error('a click on a trim handle or I on the start marked the reel as edited')
  }
  // the new reel has arrived once its toast shows – only then edit it
  await page.locator('[data-testid="toast"]', { hasText: 'Auto-selected' }).first().waitFor()
  const [, outBefore] = await edges(page)
  await page.evaluate(async () => {
    const handle = document.querySelector('[data-testid="handle-out"]')
    const box = handle.getBoundingClientRect()
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2]
    const fire = (type, clientX, buttons) =>
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          buttons,
          clientX,
          clientY: y
        })
      )
    fire('pointerdown', x, 1)
    // React renders the press; the move and the release then come before it can render again
    await new Promise((resolve) => setTimeout(resolve, 100))
    fire('pointermove', x - 20, 1)
    fire('pointerup', x - 20, 0)
  })
  await page.waitForTimeout(300)
  const [, outFlicked] = await edges(page)
  if (!(outFlicked < outBefore)) {
    throw new Error(`a quick flick left the out point at ${outFlicked}`)
  }
  if (!(await autoSelectAsks())) throw new Error('a quick flick on a trim handle was not saved')
  const clipIds = () =>
    page.$$eval('[data-testid="clip-item"]', (items) => items.map((item) => item.dataset.momentId))
  const before = await clipIds()
  if (before.length < 2) throw new Error(`expected ≥ 2 selected clips, got ${before.length}`)
  await page.locator('[data-testid="clip-item"]').first().getByTestId('clip-move-down').click()
  await page.waitForFunction((first) => {
    const ids = [...document.querySelectorAll('[data-testid="clip-item"]')].map(
      (i) => i.dataset.momentId
    )
    return ids[1] === first
  }, before[0])
  // two quick clicks on a chevron move that clip one place, and not the clip that slides under
  // the pointer back again
  await page.waitForTimeout(600)
  const chevron = await page
    .locator('[data-testid="clip-item"]')
    .first()
    .getByTestId('clip-move-down')
    .boundingBox()
  await page.mouse.click(chevron.x + chevron.width / 2, chevron.y + chevron.height / 2)
  await page.waitForTimeout(150)
  await page.mouse.click(chevron.x + chevron.width / 2, chevron.y + chevron.height / 2)
  await page.waitForTimeout(700)
  if ((await clipIds()).join() !== before.join()) {
    throw new Error(`two quick clicks on a chevron: ${before} is now ${await clipIds()}`)
  }
  // and the order of before those two clicks again
  await page.locator('[data-testid="clip-item"]').first().getByTestId('clip-move-down').click()
  await page.waitForFunction((first) => {
    const ids = [...document.querySelectorAll('[data-testid="clip-item"]')].map(
      (i) => i.dataset.momentId
    )
    return ids[1] === first
  }, before[0])
  const total = async () => Number(await id('total-duration').getAttribute('data-total-sec'))
  const lengthBefore = await total()
  const edgesBeforeClicks = await edges(page)
  await id('nudge-out-plus').click()
  await page.waitForFunction((value) => {
    const el = document.querySelector('[data-testid="total-duration"]')
    return Number(el?.getAttribute('data-total-sec')) > value
  }, lengthBefore)
  await id('nudge-in-plus').click()
  // one click is one step: the press steps, and neither its click nor the hold delay adds one
  await page.waitForTimeout(600)
  const edgesAfterClicks = await edges(page)
  if (edgesAfterClicks.some((t, i) => Math.abs(t - edgesBeforeClicks[i] - 0.5) > 0.01)) {
    throw new Error(`one click on each +: ${edgesBeforeClicks} → ${edgesAfterClicks}`)
  }
  await trimKeys(page)
  // a click on a handle focuses it, so ← → move that edge by 0.1 s (⇧ 1 s)
  await id('handle-out').click()
  const [, outBeforeArrows] = await edges(page)
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Shift+ArrowRight')
  await page.waitForTimeout(200)
  const [, outArrowed] = await edges(page)
  if (
    Math.abs(outArrowed - outBeforeArrows - 0.9) > 0.01 ||
    Math.abs((await playhead(page)) - (outArrowed - 2)) > 0.11
  ) {
    throw new Error(`← ⇧→ on the clicked end handle: ${outBeforeArrows} → ${outArrowed}`)
  }
  // holding + keeps adding steps until it is released
  const plus = await id('nudge-out-plus').boundingBox()
  await page.mouse.move(plus.x + plus.width / 2, plus.y + plus.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(1000)
  await page.mouse.up()
  const [, outHeld] = await edges(page)
  await page.waitForTimeout(400)
  const [, outReleased] = await edges(page)
  if (outHeld - outArrowed < 1.49 || outReleased !== outHeld) {
    throw new Error(
      `holding + for 1 s: end ${outArrowed} → ${outHeld}, after release ${outReleased}`
    )
  }
  if (Math.abs((await playhead(page)) - (outHeld - 2)) > 0.11) {
    throw new Error(
      `after holding +, the playhead is at ${await playhead(page)}, not ${outHeld - 2}`
    )
  }
  // a drag out and back to where it began leaves no draft behind: "Gemini-Zeiten" then shows
  // Gemini's times (and turns itself off), not the times from before the drag
  const outBox = await id('handle-out').boundingBox()
  const [ox, oy] = [outBox.x + outBox.width / 2, outBox.y + outBox.height / 2]
  await page.mouse.move(ox, oy)
  await page.mouse.down()
  await page.mouse.move(ox + 40, oy, { steps: 4 })
  await page.mouse.move(ox, oy, { steps: 4 })
  await page.mouse.up()
  await id('reset-times').click()
  await page.waitForTimeout(300)
  if (await id('reset-times').isEnabled()) {
    throw new Error(`a drag back, then "Gemini-Zeiten": the clip shows ${await edges(page)}`)
  }
  await page.keyboard.press('Space')
  await page.waitForTimeout(400)
  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('i')
  const reelBeforeX = await clipIds()
  await page.keyboard.press('x')
  const countIs = (testId, count) =>
    page.waitForFunction(
      ([selector, n]) => document.querySelectorAll(selector).length === n,
      [`[data-testid="${testId}"]`, count]
    )
  await countIs('clip-item', before.length - 1)
  // X offers no "Undo" (the row's ✕ does, below): X again is the way back
  const undoToast = page.locator('[data-testid="toast"]', {
    hasText: 'was removed from the highlight video'
  })
  await page.waitForTimeout(300)
  if ((await undoToast.count()) !== 0) throw new Error('X offered "Undo"')
  // X only toggles the shown clip: X X puts it back in its place, and ↓ after X walks the reel it
  // came from (not the suggestions it joined), so X ↓ X takes out the clip and its next neighbour
  const reelAfterX = await clipIds()
  const xId = reelBeforeX.find((clipId) => !reelAfterX.includes(clipId))
  const neighbour = reelBeforeX[reelBeforeX.indexOf(xId) + 1]
  if (!neighbour) throw new Error(`X ↓ X needs a clip after clip ${reelBeforeX.indexOf(xId) + 1}`)
  await page.keyboard.press('x')
  await countIs('clip-item', before.length)
  if ((await clipIds()).join() !== reelBeforeX.join()) {
    throw new Error(`X X: ${reelBeforeX} → ${await clipIds()}`)
  }
  await page.keyboard.press('x')
  await countIs('clip-item', before.length - 1)
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(250)
  await page.keyboard.press('x')
  await page.waitForTimeout(300)
  const reelAfterXDownX = await clipIds()
  const expected = reelBeforeX.filter((clipId) => clipId !== xId && clipId !== neighbour)
  if (reelAfterXDownX.join() !== expected.join()) {
    const removed = reelBeforeX.filter((clipId) => !reelAfterXDownX.includes(clipId))
    const added = reelAfterXDownX.filter((clipId) => !reelBeforeX.includes(clipId))
    throw new Error(
      `X ↓ X took out [${removed}] and added [${added}] – expected ${xId} and ${neighbour} out`
    )
  }
  // the same on "More suggestions": X ↓ X takes in a suggestion (not the very first one) and the
  // one below it; one more clip out of the reel makes a third suggestion
  await page.locator('[data-testid="clip-item"]').last().getByTestId('clip-toggle').click()
  await countIs('clip-item', before.length - 3)
  const reelBeforeSuggestions = await clipIds()
  await id('tab-suggestions').click()
  const suggestionIds = () =>
    page.$$eval('[data-testid="suggestion-item"]', (items) => items.map((i) => i.dataset.momentId))
  const [, second, third] = await suggestionIds()
  if (!third) throw new Error('X ↓ X on the suggestions needs three suggestions')
  // a row that left the list (with more than 10 suggestions the next best one moves up)
  const rowGone = (momentId) =>
    page
      .locator(`[data-testid="suggestion-item"][data-moment-id="${momentId}"]`)
      .waitFor({ state: 'detached' })
  await page.locator(`[data-moment-id="${second}"] .suggestion__main`).click()
  await page.keyboard.press('x')
  await rowGone(second)
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(250)
  await page.keyboard.press('x')
  await rowGone(third)
  await id('tab-clips').click()
  const joined = (await clipIds()).filter((clipId) => !reelBeforeSuggestions.includes(clipId))
  if (joined.sort().join() !== [second, third].sort().join()) {
    throw new Error(`X ↓ X on the suggestions took in [${joined}], not ${second} ${third}`)
  }
  await id('tab-suggestions').click()
  await page.locator('[data-testid="suggestion-item"]').first().getByTestId('clip-toggle').click()
  await id('tab-clips').click()
  await id('preview-all').click()
  await page.waitForTimeout(600)
  await step('review-preview')
  await id('preview-all').click()
  // the preview plays the highlight video as it was when it started: taking a clip out with its
  // row's ✕ ends it ("Undo" puts the clip back)
  const reelBeforePreview = await clipIds()
  await id('preview-all').click()
  await page.locator('[data-testid="preview-all"]', { hasText: 'Stop preview' }).waitFor()
  await page.locator('[data-testid="clip-item"]').last().getByTestId('clip-toggle').click()
  await countIs('clip-item', reelBeforePreview.length - 1)
  await page.waitForTimeout(300)
  if ((await id('preview-all').innerText()).includes('Stop preview')) {
    throw new Error('the preview plays on after a clip left the highlight video')
  }
  await undoToast.getByRole('button', { name: 'Undo' }).click()
  await countIs('clip-item', reelBeforePreview.length)

  // editing during the preview applies to the clip that is playing, never to the active one
  const metas = () =>
    page.$$eval('[data-testid="clip-item"] .clip__meta', (items) => items.map((i) => i.textContent))
  const metasBefore = await metas()
  await page.locator('[data-testid="clip-item"]').first().locator('.clip__main').click()
  await id('preview-all').click()
  await page.getByText(/clip 2 of/).waitFor({ timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.keyboard.press('i')
  await page.locator('[data-testid="preview-all"]', { hasText: 'Play preview' }).waitFor()
  await page.waitForTimeout(200)
  const metasAfter = await metas()
  if (metasAfter[0] !== metasBefore[0] || metasAfter[1] === metasBefore[1]) {
    throw new Error(`I during the preview: ${metasBefore.slice(0, 2)} → ${metasAfter.slice(0, 2)}`)
  }
  // the whole video in the timeline: a click on a handle changes nothing there either, and a drag
  // by 30 px moves the edge by 30 px worth of time, although the handle is grabbed in its middle.
  // Paused (the clip taken over from the preview plays on), so the playhead stays where an edit puts it
  if ((await id('play-toggle').getAttribute('aria-label')).startsWith('Pause')) {
    await id('play-toggle').click()
  }
  await id('timeline-zoom').click()
  const wideEdges = await edges(page)
  await id('handle-in').click()
  await id('handle-out').click()
  if ((await edges(page)).join() !== wideEdges.join()) {
    throw new Error(
      `a click on the trim handles (whole video) moved the clip: ${wideEdges} → ${await edges(page)}`
    )
  }
  const videoDuration = Number(await id('handle-out').getAttribute('aria-valuemax'))
  const { width: stripWidth } = await id('timeline').boundingBox()
  // outwards, on the side with more room
  const [edge, dx] = videoDuration - wideEdges[1] > wideEdges[0] ? [1, 30] : [0, -30]
  const handleBox = await id(edge ? 'handle-out' : 'handle-in').boundingBox()
  const [hx, hy] = [handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2]
  await page.mouse.move(hx, hy)
  await page.mouse.down()
  await page.mouse.move(hx + dx, hy, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const draggedEdges = await edges(page)
  const dragged = draggedEdges[edge]
  const wanted = wideEdges[edge] + (dx / stripWidth) * videoDuration
  if (Math.abs(dragged - wanted) > 0.05) {
    throw new Error(`a ${dx} px drag moved an edge ${wideEdges[edge]} → ${dragged}, not ${wanted}`)
  }
  // the release seeks to where the edit is heard: the new start, or 2 s before the new end
  const heard = edge ? Math.max(draggedEdges[0], draggedEdges[1] - 2) : draggedEdges[0]
  if (Math.abs((await playhead(page)) - heard) > 0.11) {
    throw new Error(`after the drag, the playhead is at ${await playhead(page)}, not ${heard}`)
  }
  // I and O leave a clip loop alone that was left on purpose: after a seek out of the clip and I,
  // playback runs on past the end – while a trim key seeks into its new range and loops it
  const overview = await page.locator('.timeline__overview').boundingBox()
  const seekTo = async (t) => {
    const x = overview.x + (t / videoDuration) * overview.width
    await page.mouse.click(x, overview.y + overview.height / 2)
  }
  const playFor = async (range) => {
    await page.keyboard.press('Space')
    await page.waitForTimeout((range[1] - range[0]) * 1000 + 600)
    const time = await playhead(page)
    await page.keyboard.press('Space')
    return time
  }
  for (const [t, key] of [
    [0, 'i'],
    [1, 'o'],
    [-1, 'i']
  ]) {
    await seekTo(videoDuration / 2 + t)
    await page.keyboard.press(key)
    await page.waitForTimeout(150)
  }
  await page.waitForTimeout(200)
  const leftLoop = await edges(page)
  const ranOn = await playFor(leftLoop)
  if (!(ranOn > leftLoop[1])) {
    throw new Error(`I after leaving the clip trapped playback in ${leftLoop} (at ${ranOn})`)
  }
  await page.keyboard.press(',')
  await page.waitForTimeout(200)
  const trimmedLoop = await edges(page)
  const looped = await playFor(trimmedLoop)
  if (looped < trimmedLoop[0] - 0.05 || looped > trimmedLoop[1] + 0.05) {
    throw new Error(`after "," playback left the clip ${trimmedLoop} (at ${looped})`)
  }
  await step('review-whole-video')
  // back to Gemini's times
  await id('reset-times').click()
  await page.waitForTimeout(300)
  // the reel was edited by hand: "Auto-select" asks before replacing it
  const autoSelectConfirmed = async () => {
    const done = page.locator('[data-testid="toast"]', { hasText: 'Auto-selected' })
    while ((await done.count()) > 0) {
      await done.first().getByRole('button', { name: 'Dismiss' }).click()
    }
    await id('auto-select').click()
    await id('confirm-dialog').waitFor()
    await id('confirm-ok').click()
    await id('confirm-dialog').waitFor({ state: 'detached' })
    // the new reel has arrived once its toast shows – only then edit it
    await done.first().waitFor()
  }
  await autoSelectConfirmed()
  await step('review')

  // the default 9:16 "Crop" cuts the sides off the 3:4 videos: the player shades them, right
  // on the picture, and the shade lets clicks through to the player
  const shade = await page.evaluate(() => {
    const canvas = document.querySelector('.player__canvas')
    const path = document.querySelector('.player__crop path')
    if (!canvas || !path) return null
    const box = canvas.getBoundingClientRect()
    const scale = Math.min(box.width / canvas.width, box.height / canvas.height)
    const { x, y, width, height } = path.getBoundingClientRect()
    return {
      x,
      y,
      width,
      height,
      offset: Math.abs(x - box.x - (box.width - canvas.width * scale) / 2),
      widthError: Math.abs(width - canvas.width * scale)
    }
  })
  if (!shade || shade.offset > 1 || shade.widthError > 1) {
    throw new Error(`the crop shade is missing or off the picture: ${JSON.stringify(shade)}`)
  }
  await page.mouse.click(shade.x + shade.width * 0.05, shade.y + shade.height / 2)
  await page.locator('[data-testid="play-toggle"][aria-label^="Pause"]').waitFor({ timeout: 2000 })
  await id('play-toggle').click()

  // the ✕ of a row that is not the active one offers "Undo": the clip comes back in its place
  const reelBeforeUndo = await clipIds()
  if (reelBeforeUndo.length < 3) {
    throw new Error(`"Undo" needs 3 clips, not ${reelBeforeUndo}`)
  }
  await page.locator('[data-testid="clip-item"]').first().locator('.clip__main').click()
  const thirdClip = page.locator('[data-testid="clip-item"]').nth(2)
  await thirdClip.hover()
  await thirdClip.getByTestId('clip-toggle').click()
  await countIs('clip-item', reelBeforeUndo.length - 1)
  // the toast leaves the active clip's handles and the timeline free to grab right away
  await undoToast.waitFor()
  const underToast = await page.evaluate(() =>
    ['handle-in', 'handle-out', 'timeline'].filter((testId) => {
      const box = document.querySelector(`[data-testid="${testId}"]`).getBoundingClientRect()
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return !!hit?.closest('[data-testid="toast"]')
    })
  )
  if (underToast.length > 0) throw new Error(`the "Undo" toast covers ${underToast}`)
  await undoToast.getByRole('button', { name: 'Undo' }).click()
  await countIs('clip-item', reelBeforeUndo.length)
  if ((await clipIds()).join() !== reelBeforeUndo.join()) {
    throw new Error(`✕, then "Undo": ${reelBeforeUndo} → ${await clipIds()}`)
  }

  // taking a clip out with a double click – or two quick clicks on the same spot – takes out that
  // clip only, never the one that moves up under the pointer
  const reelCount = () => page.locator('[data-testid="clip-item"]').count()
  const fullReel = await reelCount()
  const firstClip = page.locator('[data-testid="clip-item"]').first()
  await firstClip.hover()
  await firstClip.getByTestId('clip-toggle').dblclick()
  await page.waitForTimeout(400)
  if ((await reelCount()) !== fullReel - 1) {
    throw new Error(`double click on X: ${fullReel} → ${await reelCount()} clips`)
  }
  const nextClip = page.locator('[data-testid="clip-item"]').first()
  await nextClip.hover()
  const xBox = await nextClip.getByTestId('clip-toggle').boundingBox()
  await page.mouse.click(xBox.x + xBox.width / 2, xBox.y + xBox.height / 2)
  await page.waitForTimeout(150)
  await page.mouse.click(xBox.x + xBox.width / 2, xBox.y + xBox.height / 2)
  await page.waitForTimeout(400)
  if ((await reelCount()) !== fullReel - 2) {
    throw new Error(`two quick clicks on X: ${fullReel - 1} → ${await reelCount()} clips`)
  }

  // back from another step the Edit step shows the clip and tab you left; "Play preview" then
  // starts one clip before the active one
  const roundTrip = async () => {
    await id('step-export').click()
    await page.waitForSelector('[data-screen="export"]')
    await id('step-review').click()
    await page.waitForSelector('[data-screen="review"]')
  }
  const activeIds = () =>
    page.$$eval('.clip.is-active, .suggestion.is-active', (items) =>
      items.map((item) => item.dataset.momentId)
    )
  const reelBeforeTrip = await clipIds()
  if (reelBeforeTrip.length < 3) throw new Error(`clip 3 needs 3 clips, not ${reelBeforeTrip}`)
  await page.locator('[data-testid="clip-item"]').nth(2).locator('.clip__main').click()
  await roundTrip()
  if ((await activeIds()).join() !== reelBeforeTrip[2]) {
    throw new Error(`back from the export, [${await activeIds()}] is active, not clip 3`)
  }
  await page.locator('[data-testid="preview-all"]', { hasText: 'Preview from clip 2' }).waitFor()
  await id('preview-all').click()
  await page.getByText(/clip 2 of/).waitFor()
  await id('preview-all').click()
  // "More suggestions" lists the best clips that are not in the reel by score, at most 10, and
  // its count is the number of rows; ↓ walks that order. Back from another step, the same
  // suggestion is active on the same tab. Clips taken out of the reel make three suggestions; the
  // editor shows clip 1 meanwhile (a suggestion shown there would stay listed as an eleventh row).
  await page.locator('[data-testid="clip-item"]').first().locator('.clip__main').click()
  let ranked = []
  while (ranked.length < 3) {
    const reelLeft = await reelCount()
    if (reelLeft < 2)
      throw new Error(`three suggestions need more clips: ${JSON.stringify(ranked)}`)
    await page.locator('[data-testid="clip-item"]').last().getByTestId('clip-toggle').click()
    await countIs('clip-item', reelLeft - 1)
    await id('tab-suggestions').click()
    ranked = await page.$$eval('[data-testid="suggestion-item"]', (items) =>
      items.map((item) => ({
        id: item.dataset.momentId,
        score: Number(item.querySelector('.suggestion__score').textContent)
      }))
    )
    await id('tab-clips').click()
  }
  if (ranked.length > 10 || ranked.some((row, i) => i > 0 && row.score > ranked[i - 1].score)) {
    throw new Error(`"More suggestions" are not the 10 best, best first: ${JSON.stringify(ranked)}`)
  }
  await id('tab-suggestions').click()
  const shownCount = await id('tab-suggestions').locator('.review__count').innerText()
  if (Number(shownCount) !== ranked.length) {
    throw new Error(`the tab counts ${shownCount} suggestions, the list shows ${ranked.length}`)
  }
  const below = ranked[2].id
  await page.locator(`[data-moment-id="${ranked[1].id}"] .suggestion__main`).click()
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(250)
  if ((await activeIds()).join() !== below) {
    throw new Error(`↓ in "More suggestions" went to [${await activeIds()}], not ${below}`)
  }
  // ↑/↓ walk the rows of the open tab. A clip X took in keeps its place there only until the tab
  // changes: back on "More suggestions" with that clip of the reel still shown, ↓ starts at the
  // top row, and on "In the highlight video" with a suggestion shown, at clip 1
  const lowest = ranked.at(-1).id
  await page.locator(`[data-moment-id="${lowest}"] .suggestion__main`).click()
  await page.keyboard.press('x')
  await rowGone(lowest)
  await id('tab-clips').click()
  await id('tab-suggestions').click()
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(250)
  if ((await activeIds()).join() !== ranked[0].id) {
    throw new Error(
      `↓ on "More suggestions", a clip of the reel shown: [${await activeIds()}] is active, not the top row ${ranked[0].id}`
    )
  }
  await id('tab-clips').click()
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(250)
  if ((await activeIds()).join() !== (await clipIds())[0]) {
    throw new Error(
      `↓ on "In the highlight video", a suggestion shown: [${await activeIds()}] is active, not clip 1`
    )
  }
  // as it was: that clip a suggestion again, the one below the second row shown
  await page.locator(`[data-testid="clip-item"][data-moment-id="${lowest}"] .clip__main`).click()
  await page.keyboard.press('x')
  await id('tab-suggestions').click()
  await page.locator(`[data-moment-id="${below}"] .suggestion__main`).click()
  await step('review-suggestions')
  await roundTrip()
  if (
    (await id('tab-suggestions').getAttribute('aria-selected')) !== 'true' ||
    (await activeIds()).join() !== below
  ) {
    throw new Error(`back from the export, the suggestions tab lost its clip`)
  }
  // once that suggestion is gone (its video removed), the Edit step opens on clip 1 of the reel again
  const belowVideo = (
    await page.locator(`[data-moment-id="${below}"] .suggestion__meta`).innerText()
  ).match(/Video \d+/)[0]
  await id('step-videos').click()
  await page.waitForSelector('[data-screen="videos"]')
  const videoCount = await page.locator('[data-testid="video-card"]').count()
  const belowCard = page.locator('[data-testid="video-card"]').nth(Number(belowVideo.slice(6)) - 1)
  await belowCard.hover()
  await belowCard.getByTestId('remove-video').click()
  await id('confirm-ok').click()
  await countIs('video-card', videoCount - 1)
  await id('step-review').click()
  await page.waitForSelector('[data-screen="review"]')
  if (
    (await id('tab-clips').getAttribute('aria-selected')) !== 'true' ||
    (await activeIds()).join() !== (await clipIds())[0]
  ) {
    throw new Error(
      `back after removing ${belowVideo}, [${await activeIds()}] is active, not clip 1`
    )
  }
  // back to the automatic reel
  await autoSelectConfirmed()

  // the automatic reel is edited by hand again; re-analysing would now replace its clips, so it asks
  // first, and cancelling changes nothing
  const reelBefore = await clipIds()
  await page.locator('[data-testid="clip-item"]').last().getByTestId('clip-toggle').click()
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-testid="clip-item"]').length === count - 1,
    reelBefore.length
  )
  await id('step-brief').click()
  await page.waitForSelector('[data-screen="brief"]')
  await id('start-analysis').click()
  await id('confirm-dialog').waitFor()
  await step('reanalyze-confirm')
  // the dialog starts on its primary button and Tab never leaves it
  const focusInDialog = () =>
    page.evaluate(() => {
      const active = document.activeElement
      return {
        inside: !!active?.closest('[data-testid="confirm-dialog"]'),
        testId: active?.getAttribute('data-testid') ?? null
      }
    })
  if ((await focusInDialog()).testId !== 'confirm-ok') {
    throw new Error('the confirm dialog does not start on its primary button')
  }
  for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key)
    if (!(await focusInDialog()).inside) throw new Error(`${key} moved focus out of the dialog`)
  }
  await id('confirm-dialog').getByRole('button', { name: 'Cancel' }).click()
  await id('confirm-dialog').waitFor({ state: 'detached' })
  await page.waitForSelector('[data-screen="brief"]')
  await id('step-review').click()
  await page.waitForSelector('[data-screen="review"]')
  await id('go-export').click()

  // export
  await page.waitForSelector('[data-screen="export"]')
  await id('aspect-1:1').click()
  await id('fit-blur').click()
  await id('transition-crossfade').click()
  // the chosen option looks chosen while the pointer is still on it
  const chosenLook = () =>
    id('transition-crossfade').evaluate((item) => getComputedStyle(item).backgroundColor)
  await page.waitForTimeout(250)
  const underPointer = await chosenLook()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(250)
  if (underPointer !== (await chosenLook())) {
    throw new Error('the chosen "Transition" looks unchosen while the pointer is on it')
  }
  await step('export-settings')
  await id('start-export').click()
  await id('export-progress').waitFor()
  await step('exporting')
  await id('export-done').waitFor({ timeout: 30_000 })
  await step('export-done')
  await id('open-output').click()
  await id('show-in-finder').click()

  // a finished export no longer describes the reel once a clip is removed
  await id('step-review').click()
  await page.waitForSelector('[data-screen="review"]')
  // 1:1 on a blurred background cuts nothing: no shade
  await page.locator('.player__canvas').waitFor()
  if ((await page.locator('.player__crop').count()) !== 0) throw new Error('shade without a crop')
  await page.locator('[data-testid="clip-item"]').first().getByTestId('clip-toggle').click()
  await page.waitForTimeout(200)
  await id('step-export').click()
  await page.waitForSelector('[data-screen="export"]')
  await page
    .locator('[data-testid="start-export"]', { hasText: 'Create highlight video' })
    .waitFor()
  if ((await id('export-done').count()) !== 0) throw new Error('stale export shown as done')

  // settings
  await id('open-settings').click()
  await id('api-key-input').fill('broken')
  await id('test-api-key').click()
  await id('api-key-result').waitFor()
  await id('api-key-input').fill('AIzaSyD-test-key-1234567890abcdef')
  await id('save-api-key').click()
  await page.locator('[data-testid="api-key-result"]').getByText('Connected:').waitFor()
  await id('model-select').selectOption('gemini-4-argon')
  await step('settings')
  await id('close-settings').click()
  await id('go-home').click()
  await page.getByText('Test run festival').first().waitFor()
  await step('home-after')
  // "More suggestions" shows only the 10 best: with an eleventh clip outside the seeded
  // project's reel, the rows and the tab count stay at 10
  await page
    .locator('[data-testid="project-card"]', { hasText: 'Parookaville 2026' })
    .locator('.project-card__open')
    .click()
  await page.locator('[data-testid="project-name"]', { hasText: 'Parookaville 2026' }).waitFor()
  await id('step-review').click()
  await page.waitForSelector('[data-testid="clip-item"]')
  const suggestionCount = async () =>
    Number(await id('tab-suggestions').locator('.review__count').innerText())
  for (let outside = await suggestionCount(); outside < 11; outside++) {
    const reelLeft = await reelCount()
    if (reelLeft < 2) throw new Error('the seeded project has fewer than 11 clips to suggest')
    await page.locator('[data-testid="clip-item"]').last().getByTestId('clip-toggle').click()
    await countIs('clip-item', reelLeft - 1)
    // the next ✕ slides in under the pointer: clicked right away it would count as a double click
    await page.waitForTimeout(600)
  }
  await id('tab-suggestions').click()
  const cappedRows = await page.locator('[data-testid="suggestion-item"]').count()
  if (cappedRows !== 10 || (await suggestionCount()) !== 10) {
    throw new Error(
      `11 clips outside the reel: ${cappedRows} rows, count ${await suggestionCount()}, not 10`
    )
  }
  await id('go-home').click()
  await page.getByText('Test run festival').first().waitFor()
  const projectsAfter = await page.locator('[data-testid="project-card"]').count()
  if (projectsAfter !== projectsBefore + 1) {
    throw new Error(`expected one new project, got ${projectsAfter - projectsBefore}`)
  }

  // "Ask Gemini again" – self-contained: opens the project again from the start screen. The
  // dialog starts in its text field (Enter is a new line) and only with text, takes the keys from
  // the Edit step and closes with Esc; started, it adds the wish to the prompt and analyses
  // every video again. While that runs, the button is off and says why.
  {
    await page
      .locator('[data-testid="project-card"]', { hasText: 'Test run festival' })
      .locator('.project-card__open')
      .click()
    await page.waitForSelector('[data-screen="review"]')
    await page.waitForSelector('[data-testid="clip-item"]')
    const editState = () =>
      page.evaluate(() => ({
        reel: [...document.querySelectorAll('[data-testid="clip-item"]')].map(
          (item) => item.dataset.momentId
        ),
        active:
          document
            .querySelector('[data-testid="clip-item"] [aria-current="true"]')
            ?.closest('[data-testid="clip-item"]')?.dataset.momentId ?? null,
        range: ['handle-in', 'handle-out'].map((handle) =>
          document.querySelector(`[data-testid="${handle}"]`)?.getAttribute('aria-valuenow')
        )
      }))
    const editBefore = JSON.stringify(await editState())
    // the button is the third one in the header: at the app's default window size (1360×860) the
    // subtitle next to it is shown whole or not at all, never cut
    const resize = (size) =>
      app.evaluate(({ BrowserWindow }, [width, height]) => {
        const win = BrowserWindow.getAllWindows()[0]
        const before = win.getContentSize()
        win.setContentSize(width, height)
        return before
      }, size)
    const usual = await resize([1360, 860])
    await page.waitForFunction(() => window.innerWidth === 1360)
    const cut = await page.evaluate(() => {
      const subtitle = document.querySelector('.review__subtitle')
      return !!subtitle && subtitle.scrollWidth > subtitle.clientWidth
    })
    await resize(usual)
    await page.waitForFunction((width) => window.innerWidth === width, usual[0])
    if (cut) throw new Error('the Edit step cuts its subtitle at the default window size')
    await id('again-open').click()
    await id('again-dialog').waitFor()
    const focused = await page.evaluate(() => document.activeElement?.dataset.testid ?? null)
    if (focused !== 'again-wish') throw new Error(`the dialog starts on ${focused}, not its field`)
    if (!(await id('again-start').isDisabled())) {
      throw new Error('"Analyse again" works without a text')
    }
    const said = await id('again-dialog').innerText()
    for (const part of ['one request per video', 'is replaced', 'put together again']) {
      if (!said.includes(part)) throw new Error(`the dialog does not say "${part}"`)
    }
    await page.keyboard.type('More crowd.')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Less stage.')
    if ((await id('again-wish').inputValue()) !== 'More crowd.\nLess stage.') {
      throw new Error('Enter in the text field did not make a new line')
    }
    if ((await id('again-dialog').count()) !== 1 || (await id('again-start').isDisabled())) {
      throw new Error('"Analyse again" does not work with a text')
    }
    await step('again-dialog')
    // on a button of the dialog the keys of the Edit step do nothing (Space would press the button)
    await id('again-dialog').getByRole('button', { name: 'Cancel' }).focus()
    for (const key of ['x', 'ArrowDown', ',', '-', 'ArrowRight', 'i'])
      await page.keyboard.press(key)
    await page.waitForTimeout(300)
    if (JSON.stringify(await editState()) !== editBefore) {
      throw new Error('a key reached the Edit step behind the "Ask Gemini again" dialog')
    }
    // Esc closes it and starts nothing; the next time the field is empty
    await page.keyboard.press('Escape')
    await id('again-dialog').waitFor({ state: 'detached' })
    await page.waitForTimeout(300)
    if ((await page.locator('[data-screen="review"]').count()) !== 1) {
      throw new Error('Esc in the "Ask Gemini again" dialog left the Edit step')
    }
    await id('again-open').click()
    if ((await id('again-wish').inputValue()) !== '') throw new Error('the dialog kept its text')
    await id('again-wish').fill('  More crowd.\nLess stage. ')
    await id('again-start').click()
    await page.waitForSelector('[data-screen="analysis"]')
    // the Edit step during the run: the button is off and says why
    await id('step-review').click()
    await page.waitForSelector('[data-screen="review"]')
    if (
      !(await id('again-open').isDisabled()) ||
      (await id('again-open').getAttribute('title')) !== 'The analysis is running.'
    ) {
      throw new Error('"Ask Gemini again" is not off while the analysis runs')
    }
    await id('step-analysis').click()
    await page.waitForSelector('[data-screen="analysis"]')
    await step('again-running')
    await page.waitForFunction(
      () => {
        const rows = [...document.querySelectorAll('[data-testid="analysis-row"]')]
        return rows.length > 0 && rows.every((row) => row.dataset.stage === 'done')
      },
      undefined,
      { timeout: 60_000 }
    )
    // the wish is now the end of the prompt, and the Edit step has a reel again
    await id('step-brief').click()
    await page.waitForSelector('[data-screen="brief"]')
    const prompt = await id('brief-prompt').inputValue()
    if (!prompt.endsWith('\nMore crowd.\nLess stage.') || prompt.startsWith('More crowd.')) {
      throw new Error(`the prompt does not end with the wish: …${prompt.slice(-60)}`)
    }
    await step('again-brief')
    await id('step-review').click()
    await page.waitForSelector('[data-screen="review"]')
    await page.waitForSelector('[data-testid="clip-item"]')
    if (await id('again-open').isDisabled()) {
      throw new Error('"Ask Gemini again" stays off after the run')
    }
  }
} catch (error) {
  problems.push(`flow: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await app.close()
}

if (problems.length > 0) {
  console.error(`✗ ${problems.length} problem(s):\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log('✓ flow check passed')
