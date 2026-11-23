// Media sources for posters, filmstrips and the player. In the real app everything is served via
// the hc-media: protocol; the mock API swaps in a resolver with generated placeholder media.

import type { CSSProperties } from 'react'
import { mediaUrl } from '@shared/media-url'
import type { SpriteInfo, VideoInfo } from '@shared/types'

/** draws the frame at time `t` (seconds) – used by the mock instead of real video files */
export type FrameDrawer = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  t: number
) => void

export type VideoSource =
  { kind: 'url'; url: string } | { kind: 'synthetic'; key: string; draw: FrameDrawer }

export interface MediaResolver {
  image(path: string): string | null
  video(video: VideoInfo): VideoSource | null
}

const protocolResolver: MediaResolver = {
  image: (path) => mediaUrl(path),
  // the proxy is preferred; the original plays too (H.264/HEVC) while the proxy is being created
  video: (video) => ({ kind: 'url', url: mediaUrl(video.proxyPath ?? video.path) })
}

let resolver: MediaResolver = protocolResolver

export function setMediaResolver(next: MediaResolver): void {
  resolver = next
}

export function imageSrc(path: string | null | undefined): string | null {
  return path ? resolver.image(path) : null
}

export function videoSource(video: VideoInfo): VideoSource | null {
  return resolver.video(video)
}

export function spriteTileIndex(info: SpriteInfo, t: number): number {
  return Math.min(info.columns - 1, Math.max(0, Math.floor(t / info.intervalSec)))
}

/** width of one filmstrip tile when drawn `height` px tall */
export function spriteTileWidth(info: SpriteInfo, height: number): number {
  return (height * info.tileWidth) / info.tileHeight
}

/**
 * Background styles that show the filmstrip frame at time `t` in a box of `width`×`height`
 * (the frame covers the box like object-fit: cover).
 */
export function spriteFrameStyle(
  video: VideoInfo,
  t: number,
  width: number,
  height: number
): CSSProperties | null {
  const info = video.spriteInfo
  const src = imageSrc(video.spritePath)
  if (!info || !src) return null
  const scale = Math.max(width / info.tileWidth, height / info.tileHeight)
  const tileW = info.tileWidth * scale
  const tileH = info.tileHeight * scale
  const index = spriteTileIndex(info, t)
  const offsetX = (tileW - width) / 2
  const offsetY = (tileH - height) / 2
  return {
    backgroundImage: `url("${src}")`,
    backgroundRepeat: 'no-repeat',
    backgroundSize: `${info.columns * tileW}px ${tileH}px`,
    backgroundPosition: `${-(index * tileW + offsetX)}px ${-offsetY}px`
  }
}
