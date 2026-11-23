import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mediaUrl } from '@shared/media-url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTempDir, type TempDir } from '../testing/helpers'
import { createMediaAllowList } from './allowList'
import { contentTypeFor, handleMediaRequest, mediaPathFromUrl } from './mediaHandler'

let temp: TempDir
let projectsDir: string
let proxy: string
let original: string
let secret: string
const content = Buffer.from(Array.from({ length: 256 * 1024 }, (_, i) => i % 251))

beforeAll(async () => {
  temp = await makeTempDir('hc-media-')
  projectsDir = join(temp.path, 'userData', 'projects')
  const media = join(projectsDir, 'p1', 'media', 'v1')
  await mkdir(media, { recursive: true })
  proxy = join(media, 'proxy.mp4')
  await writeFile(proxy, content)
  await writeFile(join(media, 'poster.jpg'), 'jpeg')
  await writeFile(join(media, 'empty.mp4'), '')
  original = join(temp.path, 'Movies', 'My festival (1) #2 – Ü.MOV')
  await mkdir(join(temp.path, 'Movies'), { recursive: true })
  await writeFile(original, 'original video')
  secret = join(temp.path, 'userData', 'settings.json')
  await writeFile(secret, '{"secret":true}')
})

afterAll(async () => {
  await temp.cleanup()
})

const allow = (): ReturnType<typeof createMediaAllowList> =>
  createMediaAllowList({ projectsDir, isKnownVideo: (path) => path === original })

function get(url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Response> {
  return handleMediaRequest(new Request(url, { method, headers }), allow())
}

async function bytes(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer())
}

describe('handleMediaRequest', () => {
  it('serves a whole file with 200 and Content-Length', async () => {
    const response = await get(mediaUrl(proxy))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('content-length')).toBe(String(content.length))
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect((await bytes(response)).equals(content)).toBe(true)
  })

  it.each([
    ['bytes=0-99', 0, 99],
    ['bytes=1000-', 1000, content.length - 1],
    ['bytes=-500', content.length - 500, content.length - 1],
    ['bytes=200000-999999999', 200000, content.length - 1]
  ])('serves %s with 206 and Content-Range', async (header, start, end) => {
    const response = await get(mediaUrl(proxy), { Range: header })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/${content.length}`)
    expect(response.headers.get('content-length')).toBe(String(end - start + 1))
    expect((await bytes(response)).equals(content.subarray(start, end + 1))).toBe(true)
  })

  it.each(['bytes=999999999-', 'bytes=10-5', 'bytes=-0', 'bytes=nope', 'bytes=0-1,4-5'])(
    'answers %s with 416',
    async (header) => {
      const response = await get(mediaUrl(proxy), { Range: header })
      expect(response.status).toBe(416)
      expect(response.headers.get('content-range')).toBe(`bytes */${content.length}`)
    }
  )

  it('serves empty files without a range and refuses ranges on them', async () => {
    const empty = join(projectsDir, 'p1', 'media', 'v1', 'empty.mp4')
    const whole = await get(mediaUrl(empty))
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-length')).toBe('0')
    expect((await get(mediaUrl(empty), { Range: 'bytes=0-' })).status).toBe(416)
  })

  it('serves original videos of known projects, with special characters in the name', async () => {
    const response = await get(mediaUrl(original), { Range: 'bytes=0-7' })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-type')).toBe('video/quicktime')
    expect((await bytes(response)).toString()).toBe('original')
  })

  it('forbids everything outside the allow-list', async () => {
    expect((await get(mediaUrl(secret))).status).toBe(403)
    expect((await get(mediaUrl('/etc/hosts'))).status).toBe(403)
    expect((await get(mediaUrl(projectsDir))).status).toBe(403)
  })

  it('cannot be tricked by ../ segments, encoded or literal', async () => {
    const escaped = join(projectsDir, 'p1', 'media', 'v1') + '/../../../../settings.json'
    expect((await get(mediaUrl(escaped))).status).toBe(403)
    const staysInside = join(projectsDir, 'p1', 'media', 'v1') + '/../../../settings.json'
    expect((await get(mediaUrl(staysInside))).status).toBe(404)
    const literal = `hc-media://local/${encodeURIComponent(projectsDir)}/../../settings.json`
    expect((await get(literal)).status).not.toBe(200)
    const doubleEncoded = mediaUrl(projectsDir + '/p1/%2E%2E/%2E%2E/settings.json')
    expect((await get(doubleEncoded)).status).toBe(404)
    const sibling = mediaUrl(projectsDir + '-evil/x.mp4')
    expect((await get(sibling)).status).toBe(403)
  })

  it('returns 404 for missing files and folders inside the allow-list', async () => {
    expect((await get(mediaUrl(join(projectsDir, 'p1', 'media', 'v1', 'sprite.jpg')))).status).toBe(
      404
    )
    expect((await get(mediaUrl(join(projectsDir, 'p1', 'media')))).status).toBe(404)
  })

  it('only answers GET', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      const response = await get(mediaUrl(proxy), {}, method)
      expect(response.status, method).toBe(405)
      expect(response.headers.get('allow')).toBe('GET')
    }
  })

  it('rejects foreign or malformed URLs with 400', async () => {
    expect((await get(`hc-media://other/${encodeURIComponent(proxy)}`)).status).toBe(400)
    expect((await get('hc-media://local/%E0%A4%A')).status).toBe(400)
    expect((await get('hc-media://local/relative%2Fpath.mp4')).status).toBe(400)
    expect((await get('hc-media://local/%2Fetc%00%2Fpasswd')).status).toBe(400)
  })
})

describe('media URL helpers', () => {
  it('round-trips mediaUrl() and ignores query and hash', () => {
    expect(mediaPathFromUrl(mediaUrl(original))).toBe(original)
    expect(mediaPathFromUrl(mediaUrl(proxy) + '?t=3#x')).toBe(proxy)
    expect(mediaPathFromUrl('https://local/%2Fetc')).toBeNull()
  })

  it('maps extensions to content types', () => {
    expect(contentTypeFor('/a/b.M4V')).toBe('video/mp4')
    expect(contentTypeFor('/a/poster.jpg')).toBe('image/jpeg')
    expect(contentTypeFor('/a/sprite.PNG')).toBe('image/png')
    expect(contentTypeFor('/a/notes.txt')).toBe('application/octet-stream')
  })
})

describe('createMediaAllowList', () => {
  it('accepts files strictly inside the projects folder and known originals', () => {
    const isAllowed = createMediaAllowList({
      projectsDir: '/data/projects',
      isKnownVideo: (p) => p === '/Movies/a.mp4'
    })
    expect(isAllowed('/data/projects/p1/media/v1/proxy.mp4')).toBe(true)
    expect(isAllowed('/data/projects/p1/../p2/project.json')).toBe(true)
    expect(isAllowed('/data/projects')).toBe(false)
    expect(isAllowed('/data/projects/../settings.json')).toBe(false)
    expect(isAllowed('/data/projects-evil/x.mp4')).toBe(false)
    expect(isAllowed('/Movies/./a.mp4')).toBe(true)
    expect(isAllowed('/Movies/b.mp4')).toBe(false)
  })
})
