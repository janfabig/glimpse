import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTempDir } from '../testing/helpers'
import {
  exportBaseName,
  exportTimestamp,
  outputKey,
  sanitizeFileName,
  uniqueOutputPath
} from './outputName'

describe('output names', () => {
  it('formats the local time as YYYY-MM-DD HH.mm', () => {
    expect(exportTimestamp(new Date(2026, 0, 5, 7, 3))).toBe('2026-01-05 07.03')
  })

  it('builds "<project name> – Highlights <stamp>"', () => {
    expect(exportBaseName('Rock am Ring', new Date(2026, 5, 7, 23, 59))).toBe(
      'Rock am Ring – Highlights 2026-06-07 23.59'
    )
    expect(exportBaseName('  ', new Date(2026, 5, 7, 23, 59))).toBe(
      'Highlight video – Highlights 2026-06-07 23.59'
    )
  })

  it('removes path separators, colons, control characters and leading dots', () => {
    expect(sanitizeFileName('a/b\\c:d')).toBe('a-b-c-d')
    expect(sanitizeFileName('..hidden\u0000\tname\n')).toBe('hidden name')
    expect(sanitizeFileName('Fête   🎉 Ü')).toBe('Fête 🎉 Ü')
    expect([...sanitizeFileName('🎉'.repeat(150))]).toHaveLength(100)
  })

  it('appends " (2)", " (3)" … for existing or reserved files', async () => {
    const temp = await makeTempDir()
    try {
      const dir = join(temp.path, 'out')
      await mkdir(dir)
      expect(await uniqueOutputPath(dir, 'A', new Set())).toBe(join(dir, 'A.mp4'))
      await writeFile(join(dir, 'A.mp4'), '')
      expect(await uniqueOutputPath(dir, 'A', new Set())).toBe(join(dir, 'A (2).mp4'))
      expect(await uniqueOutputPath(dir, 'A', new Set([outputKey(join(dir, 'A (2).mp4'))]))).toBe(
        join(dir, 'A (3).mp4')
      )
    } finally {
      await temp.cleanup()
    }
  })

  it('treats names that differ only in case or Unicode form as the same reserved file', async () => {
    const temp = await makeTempDir()
    try {
      const dir = join(temp.path, 'out')
      await mkdir(dir)
      const reserved = new Set([outputKey(join(dir, 'Grünfest.mp4'))])
      expect(await uniqueOutputPath(dir, 'GRÜNFEST', reserved)).toBe(join(dir, 'GRÜNFEST (2).mp4'))
      expect(await uniqueOutputPath(dir, 'Gru\u0308nfest', reserved)).toBe(
        join(dir, 'Gru\u0308nfest (2).mp4')
      )
      expect(outputKey('/x/Gru\u0308nFEST.mp4')).toBe(outputKey('/x/grünfest.mp4'))
    } finally {
      await temp.cleanup()
    }
  })
})
