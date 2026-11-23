import { parseIpcError } from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import { DISK_FULL_MESSAGE, folderFullMessage } from '../errors'
import { recordingLogger } from '../testing/helpers'
import {
  DISK_RESERVE_BYTES,
  ensureFreeSpace,
  exportWorkBytes,
  outputFullMessage,
  type DiskSpace
} from './diskSpace'

const MB = 1024 * 1024
const EXTERNAL = '/Volumes/T7/Exporte'
const APP_DATA = '/Users/demo/Library/Application Support/Glimpse/projects/p1'

/** an external SSD under /Volumes, everything else on the Mac's disk; `existing`: known paths */
function fakeDisk(free: Record<string, number>, existing?: (path: string) => boolean): DiskSpace {
  const volume = (path: string): string => (path.startsWith('/Volumes/T7') ? 'ssd' : 'mac')
  return {
    freeBytes: async (path) => free[volume(path)] ?? null,
    volumeId: async (path) => (!existing || existing(path) ? volume(path) : null)
  }
}

async function messageOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (err: unknown) => parseIpcError(err).message
  )
}

describe('ensureFreeSpace', () => {
  const ctx = (disk: DiskSpace): { disk: DiskSpace; log: ReturnType<typeof recordingLogger> } => ({
    disk,
    log: recordingLogger()
  })
  const exportNeeds = [
    { path: EXTERNAL, bytes: 100 * MB, fullMessage: folderFullMessage(EXTERNAL) },
    { path: APP_DATA, bytes: 100 * MB }
  ]

  it('names the export folder when its own volume is short', async () => {
    const disk = fakeDisk({ ssd: 10 * MB, mac: 500_000 * MB })
    expect(await messageOf(ensureFreeSpace(ctx(disk), exportNeeds))).toBe(
      folderFullMessage(EXTERNAL)
    )
  })

  it('says the Mac is full when the volume also holds the app data', async () => {
    const disk = fakeDisk({ ssd: 500_000 * MB, mac: 150 * MB })
    expect(await messageOf(ensureFreeSpace(ctx(disk), exportNeeds))).toBe(DISK_FULL_MESSAGE)
    // export folder and app data on the Mac: the needs add up, and it is the Mac that is full
    const sameVolume = [
      { path: '/Users/jan/Movies', bytes: 100 * MB, fullMessage: folderFullMessage('/x') },
      { path: APP_DATA, bytes: 100 * MB }
    ]
    const tight = fakeDisk({ mac: 150 * MB + DISK_RESERVE_BYTES })
    expect(await messageOf(ensureFreeSpace(ctx(tight), sameVolume))).toBe(DISK_FULL_MESSAGE)
    const enough = fakeDisk({ mac: 200 * MB + DISK_RESERVE_BYTES })
    expect(await messageOf(ensureFreeSpace(ctx(enough), sameVolume))).toBeNull()
  })
})

describe('outputFullMessage (an export folder that cannot even be created)', () => {
  it('names a folder on another volume – also while it does not exist yet', async () => {
    const missing = `${EXTERNAL}/New/Deeper`
    const disk = fakeDisk({}, (path) => !path.startsWith(`${EXTERNAL}/New`))
    expect(await outputFullMessage(disk, missing, APP_DATA)).toBe(folderFullMessage(missing))
  })

  it('blames the Mac when the folder is on the app data’s volume, or nothing is known', async () => {
    expect(await outputFullMessage(fakeDisk({}), '/Users/jan/Movies/HC', APP_DATA)).toBe(
      DISK_FULL_MESSAGE
    )
    const unknown: DiskSpace = { freeBytes: async () => null, volumeId: async () => null }
    expect(await outputFullMessage(unknown, EXTERNAL, APP_DATA)).toBe(DISK_FULL_MESSAGE)
  })
})

describe('exportWorkBytes', () => {
  it('is the final stream for hard cuts', () => {
    expect(exportWorkBytes(1000, null)).toBe(1000)
  })

  it('is the near-lossless clips plus the longest segment for a crossfade', () => {
    // each clip is deleted once its segment is written: never both sets completely
    expect(exportWorkBytes(1000, 0.2)).toBe(1700)
    expect(exportWorkBytes(1000, 1)).toBe(2500)
  })
})
