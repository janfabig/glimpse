import { normalize } from 'node:path'
import { isPathInside } from '../fsx'
import type { MediaAllowList } from './mediaHandler'

export interface AllowListOptions {
  /** <userData>/projects – posters, proxies and filmstrips live below it */
  projectsDir: string
  /** original video files of known projects */
  isKnownVideo: (path: string) => boolean
}

export function createMediaAllowList(options: AllowListOptions): MediaAllowList {
  const root = normalize(options.projectsDir)
  return (path) => {
    const candidate = normalize(path)
    return isPathInside(candidate, root) || options.isKnownVideo(candidate)
  }
}
