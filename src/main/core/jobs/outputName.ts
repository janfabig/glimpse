// "<project name> – Highlights <YYYY-MM-DD HH.mm>.mp4" in the output folder, never overwriting.

import { join } from 'node:path'
import { pathExists } from '../fsx'

const MAX_NAME_CHARS = 100
const FALLBACK_NAME = 'Highlight video'

/** file-system safe project name: no path separators, colons or control characters */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[/\\:]/g, '-')
    .replace(/[\t\n\r\v\f]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim()
  return [...cleaned].slice(0, MAX_NAME_CHARS).join('').trim()
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** local time, e.g. "2026-07-12 21.14" */
export function exportTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}.${pad(date.getMinutes())}`
  )
}

export function exportBaseName(projectName: string, date: Date): string {
  return `${sanitizeFileName(projectName) || FALLBACK_NAME} – Highlights ${exportTimestamp(date)}`
}

/**
 * How a path is compared with the reservations of running exports. APFS (like HFS+) ignores case
 * and Unicode normalisation by default: "Grünfest" (NFC or NFD) and "GRÜNFEST" are the same file.
 */
export function outputKey(path: string): string {
  return path.normalize('NFC').toLowerCase()
}

/**
 * First free name: "<base>.mp4", "<base> (2).mp4", … Paths whose outputKey() is in `reserved`
 * (exports that are still rendering) count as taken, so two exports never pick the same file.
 */
export async function uniqueOutputPath(
  dir: string,
  baseName: string,
  reserved: ReadonlySet<string>
): Promise<string> {
  for (let n = 1; n < 10_000; n++) {
    const candidate = join(dir, n === 1 ? `${baseName}.mp4` : `${baseName} (${n}).mp4`)
    if (!reserved.has(outputKey(candidate)) && !(await pathExists(candidate))) return candidate
  }
  throw new Error(`no free output name for ${baseName} in ${dir}`)
}
