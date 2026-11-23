// Generated placeholder media for the mock API: stylised night/festival scenes drawn on a canvas,
// used for posters, filmstrip sprites and the (synthetic) player. Paths look like
// "mock://<theme>/<seed>/<poster.jpg|sprite.jpg|proxy.mp4>".

import type { SpriteInfo, VideoInfo } from '@shared/types'
import { setMediaResolver, type FrameDrawer } from '../lib/media'

export type MockTheme = 'stage' | 'tent' | 'night' | 'city' | 'fireworks'

export function mockMediaPath(theme: MockTheme, seed: string, file: string): string {
  return `mock://${theme}/${seed}/${file}`
}

export function parseMockPath(
  path: string
): { theme: MockTheme; seed: string; file: string } | null {
  const match = /^mock:\/\/([a-z]+)\/([^/]+)\/(.+)$/.exec(path)
  return match ? { theme: match[1] as MockTheme, seed: match[2], file: match[3] } : null
}

/** sprite geometry as main would produce it (tile width 160, ≤ 120 tiles) */
export function mockSpriteInfo(durationSec: number, width: number, height: number): SpriteInfo {
  const intervalSec = Math.max(1, Math.ceil(durationSec / 120))
  return {
    columns: Math.max(1, Math.ceil(durationSec / intervalSec)),
    intervalSec,
    tileWidth: 160,
    tileHeight: Math.round((160 * height) / width)
  }
}

// ---------------------------------------------------------------------------
// Scene drawing
// ---------------------------------------------------------------------------

type Rand = () => number

function seededRandom(seed: string): Rand {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return (h >>> 0) / 4294967296
  }
}

function fillGradient(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  stops: [number, string][]
): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, h)
  for (const [offset, color] of stops) gradient.addColorStop(offset, color)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, w, h)
}

function glow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string
): void {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius)
  gradient.addColorStop(0, color)
  gradient.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2)
}

function drawCrowd(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  rand: Rand,
  t: number,
  color: string
): void {
  ctx.fillStyle = color
  ctx.strokeStyle = color
  ctx.lineCap = 'round'
  const rows = [
    { y: 0.8, size: 0.045, count: 12 },
    { y: 0.9, size: 0.075, count: 7 }
  ]
  for (const row of rows) {
    for (let i = 0; i < row.count; i++) {
      const x = ((i + 0.5 + (rand() - 0.5) * 0.7) / row.count) * w
      const size = row.size * w * (0.85 + rand() * 0.3)
      const y = h * row.y + Math.sin(t * 4.2 + i * 1.3) * h * 0.007
      ctx.beginPath()
      ctx.arc(x, y, size * 0.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.ellipse(x, y + size * 1.25, size * 1.05, size * 0.75, 0, Math.PI, 0)
      ctx.fill()
      ctx.fillRect(x - size * 1.05, y + size * 1.24, size * 2.1, h)
      if (rand() > 0.62) {
        ctx.lineWidth = size * 0.32
        ctx.beginPath()
        ctx.moveTo(x + size * 0.75, y + size * 1.0)
        ctx.lineTo(x + size * 1.25, y - size * 1.5 + Math.sin(t * 3.6 + i) * size * 0.35)
        ctx.stroke()
      }
    }
  }
}

function drawBeams(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  hue: number,
  count: number,
  originY: number
): void {
  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < count; i++) {
    const x0 = w * (0.12 + (i * 0.76) / Math.max(1, count - 1))
    const angle = Math.sin(t * (0.45 + i * 0.11) + i * 1.7) * 0.55
    const reach = h * 1.2
    const spread = 0.06
    ctx.fillStyle = `hsla(${(hue + i * 32) % 360}, 95%, 72%, 0.11)`
    ctx.beginPath()
    ctx.moveTo(x0, originY)
    ctx.lineTo(x0 + Math.sin(angle - spread) * reach, originY - Math.cos(angle - spread) * reach)
    ctx.lineTo(x0 + Math.sin(angle + spread) * reach, originY - Math.cos(angle + spread) * reach)
    ctx.closePath()
    ctx.fill()
  }
  ctx.globalCompositeOperation = 'source-over'
}

function drawStage(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  rand: Rand,
  t: number
): void {
  const hue = 215 + rand() * 90
  fillGradient(ctx, w, h, [
    [0, `hsl(${hue}, 70%, 6%)`],
    [0.55, `hsl(${hue + 20}, 62%, 15%)`],
    [1, `hsl(${hue + 35}, 55%, 7%)`]
  ])
  glow(ctx, w * (0.42 + rand() * 0.16), h * 0.44, w * 0.75, `hsla(${hue + 70}, 95%, 62%, 0.5)`)
  const pulse = 0.28 + 0.12 * Math.sin(t * 1.4)
  ctx.fillStyle = `hsla(${(hue + 140 + Math.sin(t * 0.6) * 40) % 360}, 90%, 62%, ${pulse})`
  ctx.fillRect(w * 0.18, h * 0.33, w * 0.64, h * 0.15)
  drawBeams(ctx, w, h, t, hue + 40, 6, h * 0.34)
  drawCrowd(ctx, w, h, rand, t, `hsl(${hue}, 45%, 3%)`)
}

function drawTent(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  rand: Rand,
  t: number
): void {
  const hue = 150 + rand() * 60
  fillGradient(ctx, w, h, [
    [0, '#020309'],
    [0.6, `hsl(${hue + 120}, 40%, 8%)`],
    [1, '#010207']
  ])
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineWidth = Math.max(1, w * 0.004)
  for (let i = 0; i < 9; i++) {
    const angle = -Math.PI / 2 + Math.sin(t * 0.9 + i * 0.7) * 1.1
    ctx.strokeStyle = `hsla(${hue}, 100%, 60%, 0.5)`
    ctx.beginPath()
    ctx.moveTo(w * 0.5, h * 0.36)
    ctx.lineTo(w * 0.5 + Math.cos(angle) * w * 1.2, h * 0.36 + Math.sin(angle) * w * 1.2)
    ctx.stroke()
  }
  ctx.globalCompositeOperation = 'source-over'
  glow(ctx, w * 0.5, h * 0.36, w * 0.25, `hsla(${hue}, 100%, 70%, 0.55)`)
  const strobe = Math.max(0, Math.sin(t * 9.5)) ** 80
  if (strobe > 0.02) {
    ctx.fillStyle = `rgba(255,255,255,${0.22 * strobe})`
    ctx.fillRect(0, 0, w, h)
  }
  drawCrowd(ctx, w, h, rand, t, '#010106')
}

function drawNight(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  rand: Rand,
  t: number
): void {
  const hue = 18 + rand() * 25
  fillGradient(ctx, w, h, [
    [0, `hsl(${hue + 200}, 35%, 7%)`],
    [0.5, `hsl(${hue}, 55%, 16%)`],
    [1, `hsl(${hue}, 45%, 6%)`]
  ])
  for (let i = 0; i < 14; i++) {
    const x = rand() * w
    const y = rand() * h * 0.6
    const radius = w * (0.04 + rand() * 0.07)
    const flicker = 0.25 + 0.15 * Math.sin(t * (1 + rand()) + i)
    glow(ctx, x, y, radius, `hsla(${hue + rand() * 30}, 95%, 65%, ${flicker})`)
  }
  ctx.fillStyle = `hsl(${hue}, 40%, 5%)`
  ctx.fillRect(0, h * 0.74, w, h * 0.26)
  for (let i = 0; i < 4; i++) {
    const x = w * (0.2 + i * 0.2) + Math.sin(t + i) * w * 0.01
    const y = h * 0.62
    ctx.fillStyle = `hsla(${hue + 25}, 80%, 55%, 0.75)`
    ctx.fillRect(x - w * 0.03, y, w * 0.06, h * 0.11)
    ctx.fillStyle = 'rgba(255,255,255,0.6)'
    ctx.fillRect(x - w * 0.03, y, w * 0.06, h * 0.012)
  }
  drawCrowd(ctx, w, h * 0.92, rand, t * 0.4, `hsl(${hue}, 30%, 4%)`)
}

function drawCity(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  rand: Rand,
  t: number
): void {
  const hue = 10 + rand() * 30
  fillGradient(ctx, w, h, [
    [0, `hsl(${hue + 220}, 45%, 22%)`],
    [0.45, `hsl(${hue + 330}, 60%, 55%)`],
    [0.62, `hsl(${hue + 20}, 90%, 62%)`],
    [1, `hsl(${hue + 230}, 40%, 12%)`]
  ])
  glow(ctx, w * 0.62, h * 0.55, w * 0.32, 'rgba(255,214,150,0.85)')
  let x = -w * 0.05
  while (x < w) {
    const bw = w * (0.07 + rand() * 0.1)
    const bh = h * (0.12 + rand() * 0.28)
    ctx.fillStyle = `hsl(${hue + 230}, 30%, ${8 + rand() * 6}%)`
    ctx.fillRect(x, h * 0.66 - bh, bw, bh + h * 0.4)
    ctx.fillStyle = 'rgba(255,220,160,0.55)'
    for (let wy = h * 0.66 - bh + 6; wy < h * 0.66; wy += h * 0.035) {
      if (rand() > 0.55) ctx.fillRect(x + bw * 0.25, wy, bw * 0.18, h * 0.012)
    }
    x += bw + w * 0.01
  }
  ctx.fillStyle = `hsla(${hue + 220}, 40%, 18%, 0.85)`
  ctx.fillRect(0, h * 0.72, w, h * 0.28)
  ctx.fillStyle = 'rgba(255,214,150,0.25)'
  for (let i = 0; i < 6; i++) {
    const y = h * (0.75 + i * 0.035)
    ctx.fillRect(w * 0.55 + Math.sin(t * 1.5 + i) * w * 0.03, y, w * 0.14, h * 0.006)
  }
}

function drawFireworks(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  rand: Rand,
  t: number
): void {
  fillGradient(ctx, w, h, [
    [0, '#030415'],
    [0.7, '#0c1236'],
    [1, '#04061a']
  ])
  ctx.globalCompositeOperation = 'lighter'
  for (let b = 0; b < 4; b++) {
    const cx = w * (0.2 + rand() * 0.6)
    const cy = h * (0.15 + rand() * 0.3)
    const hue = rand() * 360
    const phase = (t * 0.45 + b * 0.27) % 1
    const radius = w * 0.28 * phase
    const alpha = 0.9 * (1 - phase)
    for (let i = 0; i < 26; i++) {
      const angle = (i / 26) * Math.PI * 2
      ctx.fillStyle = `hsla(${hue}, 95%, 68%, ${alpha})`
      ctx.beginPath()
      ctx.arc(
        cx + Math.cos(angle) * radius,
        cy + Math.sin(angle) * radius,
        w * 0.006,
        0,
        Math.PI * 2
      )
      ctx.fill()
    }
    glow(ctx, cx, cy, radius * 0.8 + 1, `hsla(${hue}, 95%, 65%, ${alpha * 0.25})`)
  }
  ctx.globalCompositeOperation = 'source-over'
  drawCrowd(ctx, w, h, rand, t * 0.5, '#020210')
}

const SCENES: Record<
  MockTheme,
  (c: CanvasRenderingContext2D, w: number, h: number, r: Rand, t: number) => void
> = {
  stage: drawStage,
  tent: drawTent,
  night: drawNight,
  city: drawCity,
  fireworks: drawFireworks
}

export function drawMockFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  theme: MockTheme,
  seed: string,
  t: number
): void {
  ctx.save()
  SCENES[theme](ctx, w, h, seededRandom(seed), t)
  const vignette = ctx.createRadialGradient(
    w / 2,
    h / 2,
    Math.min(w, h) * 0.35,
    w / 2,
    h / 2,
    Math.max(w, h) * 0.75
  )
  vignette.addColorStop(0, 'rgba(0,0,0,0)')
  vignette.addColorStop(1, 'rgba(0,0,0,0.45)')
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, w, h)
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

interface MockVideoMeta {
  durationSec: number
  width: number
  height: number
}

const imageCache = new Map<string, string>()
const videoMeta = new Map<string, MockVideoMeta>()

/** the mock registers each video so sprite paths can be rendered with the right geometry */
export function registerMockVideo(
  video: Pick<VideoInfo, 'durationSec' | 'width' | 'height' | 'posterPath'>
): void {
  const parsed = video.posterPath ? parseMockPath(video.posterPath) : null
  if (parsed) videoMeta.set(`${parsed.theme}/${parsed.seed}`, video)
}

function renderImage(path: string): string | null {
  const parsed = parseMockPath(path)
  if (!parsed) return null
  const meta = videoMeta.get(`${parsed.theme}/${parsed.seed}`) ?? {
    durationSec: 120,
    width: 1440,
    height: 1920
  }
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  if (parsed.file.startsWith('sprite')) {
    const info = mockSpriteInfo(meta.durationSec, meta.width, meta.height)
    canvas.width = info.columns * info.tileWidth
    canvas.height = info.tileHeight
    for (let i = 0; i < info.columns; i++) {
      ctx.save()
      ctx.translate(i * info.tileWidth, 0)
      ctx.beginPath()
      ctx.rect(0, 0, info.tileWidth, info.tileHeight)
      ctx.clip()
      drawMockFrame(
        ctx,
        info.tileWidth,
        info.tileHeight,
        parsed.theme,
        parsed.seed,
        i * info.intervalSec
      )
      ctx.restore()
    }
    return canvas.toDataURL('image/jpeg', 0.72)
  }
  const scale = 480 / Math.max(meta.width, meta.height)
  canvas.width = Math.round(meta.width * scale)
  canvas.height = Math.round(meta.height * scale)
  drawMockFrame(ctx, canvas.width, canvas.height, parsed.theme, parsed.seed, meta.durationSec * 0.3)
  return canvas.toDataURL('image/jpeg', 0.85)
}

export function installMockMedia(): void {
  setMediaResolver({
    image(path) {
      const cached = imageCache.get(path)
      if (cached) return cached
      const rendered = renderImage(path)
      if (rendered) imageCache.set(path, rendered)
      return rendered
    },
    video(video) {
      const parsed = video.posterPath ? parseMockPath(video.posterPath) : null
      if (!parsed) return null
      const draw: FrameDrawer = (ctx, w, h, t) =>
        drawMockFrame(ctx, w, h, parsed.theme, parsed.seed, t)
      return { kind: 'synthetic', key: `${parsed.theme}/${parsed.seed}`, draw }
    }
  })
}
