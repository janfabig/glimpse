/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS script */
// Makes the zip for friends from the packaged app (npm run package:zip builds the app first):
//
//   dist/Glimpse-<version>.zip
//     Glimpse/
//       Glimpse.app
//       How to open Glimpse.txt      (build/How to open Glimpse.txt)
//
// The zip is written by ditto: the app's signature, its symlinks and its file modes survive, which
// a plain zip does not promise. Nothing is started and the app is not changed.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** the one folder in the zip */
export const zipFolder = 'Glimpse'

export function zipName(version) {
  if (typeof version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
    throw new Error(`package.json has no usable version: ${JSON.stringify(version)}`)
  }
  return `Glimpse-${version}.zip`
}

/** everything that goes into the folder: where it comes from and its name there */
export function zipContents(repoRoot) {
  return [
    { from: join(repoRoot, 'dist/mac-arm64/Glimpse.app'), name: 'Glimpse.app' },
    { from: join(repoRoot, 'build/How to open Glimpse.txt'), name: 'How to open Glimpse.txt' }
  ]
}

/**
 * --keepParent: the folder itself is the zip's only top-level entry. --norsrc: no "._" entries for
 * extended attributes (the signature does not need them, it lives in the app's files).
 */
export const dittoArgs = (folder, zipPath) => [
  '-c',
  '-k',
  '--keepParent',
  '--norsrc',
  folder,
  zipPath
]

async function main() {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const { version } = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  const dist = join(repoRoot, 'dist')
  const zipPath = join(dist, zipName(version))
  const contents = zipContents(repoRoot)
  for (const { from } of contents) {
    if (!existsSync(from)) throw new Error(`Missing: ${from}. Run npm run package first.`)
  }
  await mkdir(dist, { recursive: true })
  // inside dist: same volume, so the app is cloned (cp -c) and takes no extra space
  const stage = await mkdtemp(join(dist, '.zip-'))
  try {
    const folder = join(stage, zipFolder)
    await mkdir(folder)
    for (const { from, name } of contents) {
      await exec('/bin/cp', ['-cR', from, join(folder, name)])
    }
    // the copy that friends get must still be the signed app
    await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(folder, 'Glimpse.app')])
    await rm(zipPath, { force: true })
    await exec('/usr/bin/ditto', dittoArgs(folder, zipPath))
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
  console.log(`Zip for friends: ${zipPath}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
