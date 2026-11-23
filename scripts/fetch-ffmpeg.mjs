/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS script */
// Puts the pinned ffmpeg and ffprobe into vendor/ffmpeg (they are not in git): downloads the two
// zips named in vendor/ffmpeg/SOURCE.txt, checks their sha256, unpacks them and checks the binaries.
// The app ships them (electron-builder.yml → Contents/Resources/ffmpeg) and development, the tests
// and E2E use them before any other ffmpeg.
//
//   node scripts/fetch-ffmpeg.mjs           fetch what is missing or does not match
//   node scripts/fetch-ffmpeg.mjs --force   fetch both again

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

export const FFMPEG_VERSION = '9.0.2'

const BASE = `https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_${FFMPEG_VERSION}`

/** Apple silicon builds; a new version changes all of this and vendor/ffmpeg/SOURCE.txt */
export const PINNED = [
  {
    name: 'ffmpeg',
    url: `${BASE}/ffmpeg.zip`,
    zipSha256: 'c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924',
    sha256: '2e11c6f90993cdb79fff84d3f90044d28316b310e75b3e030cfc9a54f2c9d384'
  },
  {
    name: 'ffprobe',
    url: `${BASE}/ffprobe.zip`,
    zipSha256: 'fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6',
    sha256: '2738aa46a7f9acbc8ab09a6715554c90f7de603171ac403726765685df6a0059'
  }
]

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/** throws unless `data` has the pinned checksum: nothing unchecked is unpacked or kept */
export function assertSha256(what, data, expected) {
  const actual = sha256(data)
  if (actual !== expected) {
    throw new Error(`${what} has the wrong checksum.\n  expected ${expected}\n  got      ${actual}`)
  }
}

/** where a pinned tool lives in the repo */
export function vendorPath(repoRoot, name) {
  if (!PINNED.some((tool) => tool.name === name)) throw new Error(`Not a pinned tool: ${name}`)
  return join(repoRoot, 'vendor/ffmpeg', name)
}

async function hasPinned(path, expected) {
  try {
    return sha256(await readFile(path)) === expected
  } catch {
    return false
  }
}

async function fetchTool(tool, target, workDir) {
  console.log(`Downloading ${tool.url} …`)
  const response = await fetch(tool.url)
  if (!response.ok) throw new Error(`${tool.url}: HTTP ${response.status}`)
  const zip = Buffer.from(await response.arrayBuffer())
  assertSha256(`${tool.name}.zip`, zip, tool.zipSha256)
  const zipPath = join(workDir, `${tool.name}.zip`)
  await writeFile(zipPath, zip)
  // only the one member, by name, into the work folder: the archive cannot write anywhere else
  await promisify(execFile)('/usr/bin/unzip', ['-q', '-o', zipPath, tool.name, '-d', workDir])
  const unpacked = join(workDir, tool.name)
  assertSha256(tool.name, await readFile(unpacked), tool.sha256)
  await copyFile(unpacked, target)
  await chmod(target, 0o755)
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('The pinned ffmpeg is built for macOS on Apple silicon only.')
  }
  const force = process.argv.includes('--force')
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  await mkdir(join(repoRoot, 'vendor/ffmpeg'), { recursive: true })
  const workDir = await mkdtemp(join(tmpdir(), 'fetch-ffmpeg-'))
  try {
    for (const tool of PINNED) {
      const target = vendorPath(repoRoot, tool.name)
      if (!force && (await hasPinned(target, tool.sha256))) {
        await chmod(target, 0o755)
        console.log(`${tool.name} ${FFMPEG_VERSION} is already in vendor/ffmpeg.`)
        continue
      }
      await fetchTool(tool, target, workDir)
      console.log(`${tool.name} ${FFMPEG_VERSION} → ${target}`)
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
