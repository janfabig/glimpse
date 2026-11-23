// Free-space checks before work that writes large files (proxies, exports): a full disk is
// reported before ffmpeg starts instead of failing halfway with a generic error.

import { stat, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DISK_FULL_MESSAGE, fail, folderFullMessage } from '../errors'
import type { Logger } from '../log'

export interface DiskSpace {
  /** bytes available to the user on the volume of `path` (an existing path); null when unknown */
  freeBytes(path: string): Promise<number | null>
  /** identifies the volume `path` lives on; null when unknown */
  volumeId(path: string): Promise<string | null>
}

export const systemDiskSpace: DiskSpace = {
  async freeBytes(path) {
    try {
      const info = await statfs(path)
      // some virtual file systems report no blocks at all: that is "unknown", not "full"
      if (!(info.blocks > 0) || !(info.bsize > 0)) return null
      return info.bavail * info.bsize
    } catch {
      return null
    }
  },
  async volumeId(path) {
    try {
      return String((await stat(path)).dev)
    } catch {
      return null
    }
  }
}

/** headroom on top of every estimate: project files, logs, the system's own needs */
export const DISK_RESERVE_BYTES = 64 * 1024 * 1024

export interface SpaceNeed {
  /** an existing folder on the volume that has to hold the data */
  path: string
  bytes: number
  /**
   * what the user reads when this volume is short – e.g. the export folder on an external drive;
   * default (and always when the app's data shares the volume): the Mac's disk is full
   */
  fullMessage?: string
}

/** fails with the disk-full message when a volume cannot hold what is about to be written */
export async function ensureFreeSpace(
  ctx: { disk: DiskSpace; log: Logger },
  needs: readonly SpaceNeed[]
): Promise<void> {
  // needs on the same volume add up
  const volumes = new Map<string, SpaceNeed>()
  for (const need of needs) {
    const id = (await ctx.disk.volumeId(need.path)) ?? `path:${need.path}`
    const known = volumes.get(id)
    if (!known) {
      volumes.set(id, { ...need })
      continue
    }
    known.bytes += need.bytes
    // the volume also holds the app's data: it is the Mac's disk
    if (need.fullMessage === undefined) delete known.fullMessage
  }
  for (const { path, bytes, fullMessage } of volumes.values()) {
    const free = await ctx.disk.freeBytes(path)
    const needed = Math.ceil(bytes) + DISK_RESERVE_BYTES
    if (free !== null && free < needed) {
      ctx.log.warn('disk', 'not enough free space – not started', { path, free, needed })
      fail('internal', fullMessage ?? DISK_FULL_MESSAGE)
    }
  }
}

/** the volume of `path` – or, while it does not exist yet, of its nearest existing parent */
async function volumeOfNearest(disk: DiskSpace, path: string): Promise<string | null> {
  for (let current = path; ; current = dirname(current)) {
    const id = await disk.volumeId(current)
    if (id !== null || dirname(current) === current) return id
  }
}

/**
 * The full-disk text for the export folder: named when it lies on another volume than the app's
 * data (an external drive – space on the Mac would not help), else the Mac's disk.
 */
export async function outputFullMessage(
  disk: DiskSpace,
  outputDir: string,
  appDataDir: string
): Promise<string> {
  const [output, appData] = await Promise.all([
    volumeOfNearest(disk, outputDir),
    volumeOfNearest(disk, appDataDir)
  ])
  return output !== null && output !== appData ? folderFullMessage(outputDir) : DISK_FULL_MESSAGE
}

/** ~2.5 Mbit/s video (media/proxy.ts) + audio, generously, plus the filmstrip */
const PROXY_BYTES_PER_SEC = 3_000_000 / 8
const SPRITE_BYTES = 4 * 1024 * 1024

export function estimateProxyBytes(durationSec: number): number {
  return Math.ceil(Math.max(0, durationSec) * PROXY_BYTES_PER_SEC) + SPRITE_BYTES
}

/**
 * Hard cuts render the final stream directly. Crossfades render near-lossless clips first (× 1.5)
 * and then segment by segment at final quality, deleting each clip once its segment is written:
 * all clips plus the longest segment (`longestClipShare` of the reel, null for hard cuts).
 */
export function exportWorkBytes(estimate: number, longestClipShare: number | null): number {
  return Math.ceil(estimate * (longestClipShare === null ? 1 : 1.5 + longestClipShare))
}
