// Chronological ordering of videos and moments.

import type { Moment, VideoInfo } from '@shared/types'

type Placed = Pick<Moment, 'videoId' | 'start'>

/** video order (index in `videos`), then start; moments of unknown videos go last */
export function chronologicalComparator(
  videos: readonly VideoInfo[]
): (a: Placed, b: Placed) => number {
  const index = new Map(videos.map((video, i) => [video.id, i]))
  const position = (videoId: string): number => index.get(videoId) ?? Number.MAX_SAFE_INTEGER
  return (a, b) => position(a.videoId) - position(b.videoId) || a.start - b.start
}

/**
 * Inserts each added moment next to its chronological neighbour: right after the closest earlier
 * moment (video order, then start; ties: the last one), else right before the closest later one.
 * In a chronological array that is its chronological position; in a reel the user reordered it
 * lands beside its neighbour instead of in front of a clip moved to the start. The existing
 * moments keep their order. Returns a new array.
 */
export function insertChronologically<T extends Placed>(
  moments: readonly T[],
  added: readonly T[],
  videos: readonly VideoInfo[]
): T[] {
  const compare = chronologicalComparator(videos)
  const result = [...moments]
  for (const moment of [...added].sort(compare)) {
    let previous = -1
    let next = -1
    result.forEach((m, i) => {
      if (compare(m, moment) <= 0) {
        if (previous < 0 || compare(m, result[previous]) >= 0) previous = i
      } else if (next < 0 || compare(m, result[next]) < 0) {
        next = i
      }
    })
    result.splice(previous >= 0 ? previous + 1 : next >= 0 ? next : result.length, 0, moment)
  }
  return result
}

function recordedTime(video: VideoInfo): number {
  return video.recordedAt ? Date.parse(video.recordedAt) : Number.NaN
}

/** recording time (dated videos first), then file name (natural order), then id */
export function compareVideos(a: VideoInfo, b: VideoInfo): number {
  const ta = recordedTime(a)
  const tb = recordedTime(b)
  const hasA = Number.isFinite(ta)
  const hasB = Number.isFinite(tb)
  if (hasA && hasB && ta !== tb) return ta - tb
  if (hasA !== hasB) return hasA ? -1 : 1
  return (
    a.fileName.localeCompare(b.fileName, 'de', { numeric: true, sensitivity: 'base' }) ||
    a.id.localeCompare(b.id)
  )
}
