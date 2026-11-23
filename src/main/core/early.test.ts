import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const switches: string[] = []
  return {
    switches,
    app: {
      isPackaged: true,
      setName: (): void => undefined,
      setPath: (): void => undefined,
      // no folder of the former name there: nothing moves
      getPath: (): string => '/nonexistent/Application Support/Glimpse',
      commandLine: {
        hasSwitch: (name: string): boolean => switches.includes(name),
        removeSwitch: (name: string): void => {
          if (switches.includes(name)) switches.splice(switches.indexOf(name), 1)
        }
      }
    }
  }
})
vi.mock('electron', () => ({ app: electron.app }))

/** runs early.ts the way a start of the packaged app does */
async function packagedStart(switches: string[]): Promise<void> {
  electron.switches.splice(0, Infinity, ...switches)
  vi.resetModules()
  await import('./early')
}

beforeEach(() => {
  vi.stubEnv('HC_E2E', '')
  vi.stubEnv('HC_USER_DATA_DIR', '')
  vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('start-up hardening of the packaged app', () => {
  it('drops remote debugging and the TLS override before anything else runs', async () => {
    await packagedStart(['remote-debugging-port', 'remote-debugging-pipe'])
    expect(electron.switches).toEqual([])
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
    expect(process.exit).not.toHaveBeenCalled()
  })

  it('refuses a start with --js-flags', async () => {
    await packagedStart(['js-flags'])
    expect(process.exit).toHaveBeenCalledWith(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^Glimpse: /))
  })

  it('keeps the hardening when HC_E2E=1 is set (only an unpackaged app is exempt)', async () => {
    vi.stubEnv('HC_E2E', '1')
    await packagedStart(['remote-debugging-port', 'gpu-launcher'])
    expect(electron.switches).toEqual(['gpu-launcher'])
    expect(process.exit).toHaveBeenCalledWith(1)
  })
})
