// hc-media://local/<encodeURIComponent(absolute path)> → local file, with Range support.
// Electron's net.fetch(file://) is not seekable, so responses are built by hand.

import { MEDIA_SCHEME } from '@shared/media-url'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, isAbsolute, normalize } from 'node:path'
import { Readable } from 'node:stream'
import { parseRange } from './range'

export type MediaAllowList = (absolutePath: string) => boolean

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mts': 'video/mp2t',
  '.3gp': 'video/3gpp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png'
}

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** the normalised absolute file path of a media URL; null when the URL is not one of ours */
export function mediaPathFromUrl(rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${MEDIA_SCHEME}:` || url.hostname !== 'local') return null
  let decoded: string
  try {
    decoded = decodeURIComponent(url.pathname.slice(1))
  } catch {
    return null
  }
  if (decoded === '' || decoded.includes('\0') || !isAbsolute(decoded)) return null
  // resolves "..", so the allow-list sees the file that would really be opened
  return normalize(decoded)
}

function plain(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers })
}

function fileBody(path: string, start: number, end: number): ReadableStream<Uint8Array> {
  return Readable.toWeb(
    createReadStream(path, { start, end })
  ) as unknown as ReadableStream<Uint8Array>
}

export async function handleMediaRequest(
  request: Request,
  isAllowed: MediaAllowList
): Promise<Response> {
  if (request.method !== 'GET') return plain(405, { Allow: 'GET' })
  const path = mediaPathFromUrl(request.url)
  if (path === null) return plain(400)
  if (!isAllowed(path)) return plain(403)

  let size: number
  try {
    const info = await stat(path)
    if (!info.isFile()) return plain(404)
    size = info.size
  } catch {
    return plain(404)
  }

  const headers: Record<string, string> = {
    'Content-Type': contentTypeFor(path),
    'Accept-Ranges': 'bytes',
    // posters and filmstrips are regenerated under the same name after a retry
    'Cache-Control': 'no-cache'
  }
  const range = parseRange(request.headers.get('range'), size)
  if (range.kind === 'unsatisfiable') {
    return plain(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' })
  }
  if (range.kind === 'none') {
    headers['Content-Length'] = String(size)
    return new Response(size === 0 ? null : fileBody(path, 0, size - 1), { status: 200, headers })
  }
  const { start, end } = range.range
  headers['Content-Length'] = String(end - start + 1)
  headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  return new Response(fileBody(path, start, end), { status: 206, headers })
}
