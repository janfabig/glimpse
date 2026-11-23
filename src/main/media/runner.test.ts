// Runs real processes (ffmpeg, /bin/sh) – no test videos needed.
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MESSAGES, tailLines } from './errors'
import { runFfmpeg, runProcess } from './runner'
import { FFMPEG } from './testHelpers'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('runFfmpeg', () => {
  it('reports progress fractions against the expected duration and ends with 1', async () => {
    const fractions: number[] = []
    await runFfmpeg(
      FFMPEG,
      [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=1280x720:r=30:d=3',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-f',
        'null',
        '-'
      ],
      { errorMessage: 'x', durationSec: 3, onProgress: (f) => fractions.push(f) }
    )
    expect(fractions.length).toBeGreaterThanOrEqual(1)
    expect(fractions.at(-1)).toBe(1)
    expect(fractions.every((f) => f >= 0 && f <= 1)).toBe(true)
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions)
  })

  it('rejects with MediaError("ffmpeg") and the stderr tail on failure', async () => {
    const error = await runFfmpeg(FFMPEG, ['-i', '/does/not/exist.mp4', '-f', 'null', '-'], {
      errorMessage: 'That didn’t work.'
    }).catch((err: unknown) => err)
    expect(error).toMatchObject({
      name: 'MediaError',
      code: 'ffmpeg',
      message: 'That didn’t work.'
    })
    expect((error as { details?: string }).details).toContain('No such file or directory')
  })

  it('kills ffmpeg on abort and rejects with "cancelled" once it is gone', async () => {
    const controller = new AbortController()
    let pid = 0
    const run = runFfmpeg(
      FFMPEG,
      ['-re', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30', '-f', 'null', '-'],
      {
        errorMessage: 'x',
        signal: controller.signal,
        onSpawn: (p) => (pid = p)
      }
    )
    let abortedAt = 0
    setTimeout(() => {
      abortedAt = Date.now()
      controller.abort()
    }, 300)
    await expect(run).rejects.toMatchObject({ code: 'cancelled', message: 'Cancelled.' })
    // ffmpeg honours SIGTERM, so the 2 s SIGKILL escalation is not needed
    expect(Date.now() - abortedAt).toBeLessThan(1500)
    expect(pid).toBeGreaterThan(0)
    expect(isAlive(pid)).toBe(false)
  })

  it('kills a run that takes longer than timeoutMs and fails like any other run', async () => {
    let pid = 0
    // the source ends by itself after 4 s: without the limit the run would simply succeed
    const error = await runFfmpeg(
      FFMPEG,
      ['-re', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=4', '-f', 'null', '-'],
      { errorMessage: 'That didn’t work.', timeoutMs: 300, onSpawn: (p) => (pid = p) }
    ).catch((err: unknown) => err)
    expect(error).toMatchObject({ code: 'ffmpeg', message: 'That didn’t work.' })
    expect((error as { details?: string }).details).toContain('timed out')
    expect(isAlive(pid)).toBe(false)
  })

  it('names the folder when ffmpeg may not read the input or write the output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hc-runner-'))
    const input = join(dir, 'clip.mp4')
    const locked = join(dir, 'locked')
    try {
      // prettier-ignore
      await runFfmpeg(FFMPEG, [
        '-f', 'lavfi', '-i', 'testsrc2=d=0.2', '-c:v', 'libx264', '-preset', 'ultrafast', input
      ], { errorMessage: 'x' })
      await mkdir(locked, { mode: 0o555 })
      const copy = (output: string): Promise<unknown> =>
        runFfmpeg(FFMPEG, ['-i', input, '-c', 'copy', output], {
          errorMessage: 'That didn’t work.'
        }).catch((err: unknown) => err)

      expect(await copy(join(locked, 'out.mp4'))).toMatchObject({
        code: 'ffmpeg',
        message: MESSAGES.writeDenied(locked)
      })
      await chmod(input, 0o000)
      expect(await copy(join(dir, 'out.mp4'))).toMatchObject({
        code: 'ffmpeg',
        message: MESSAGES.readDenied(dir)
      })
      await chmod(input, 0o644)
      // any other failure keeps the caller's message
      expect(await copy(join(dir, 'out.unknown-extension'))).toMatchObject({
        code: 'ffmpeg',
        message: 'That didn’t work.'
      })
    } finally {
      await chmod(input, 0o644).catch(() => undefined)
      await chmod(locked, 0o755).catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not start when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      runFfmpeg(FFMPEG, ['-version'], { errorMessage: 'x', signal: controller.signal })
    ).rejects.toMatchObject({ code: 'cancelled' })
  })
})

describe('runProcess', () => {
  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const controller = new AbortController()
    let pid = 0
    const run = runProcess('/bin/sh', ['-c', "trap '' TERM; exec sleep 30"], {
      signal: controller.signal,
      killGraceMs: 300,
      onSpawn: (p) => (pid = p)
    })
    setTimeout(() => controller.abort(), 100)
    await expect(run).rejects.toMatchObject({ code: 'cancelled' })
    expect(isAlive(pid)).toBe(false)
  })

  it('maps a missing binary to "no-ffmpeg"', async () => {
    await expect(runProcess('/nope/ffmpeg', ['-version'])).rejects.toMatchObject({
      code: 'no-ffmpeg',
      // no install hint: the packaged app has none to give, and a restart looks for ffmpeg anew
      message: 'ffmpeg could not be started. Quit Glimpse and open it again.'
    })
  })

  it('captures stdout and enforces timeouts', async () => {
    expect((await runProcess('/bin/echo', ['hi'], { captureStdout: true })).stdout).toBe('hi\n')
    const slow = await runProcess('/bin/sleep', ['5'], { timeoutMs: 100 })
    expect(slow.timedOut).toBe(true)
    expect(slow.code).not.toBe(0)
  })
})

describe('tailLines', () => {
  it('keeps the last non-empty lines', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n\n'
    expect(tailLines(text, 3)).toBe('line 27\nline 28\nline 29')
    expect(tailLines('x'.repeat(50), 20, 10)).toBe('x'.repeat(10))
  })
})
