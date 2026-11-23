import { describe, expect, it } from 'vitest'
import {
  fileNameOf,
  formatBytes,
  formatEstimate,
  formatRelative,
  formatSeconds,
  listDe,
  plural,
  shortenPath,
  tc
} from './format'

describe('format', () => {
  it('pluralises nouns', () => {
    expect(plural(1, 'video', 'videos')).toBe('1 video')
    expect(plural(3, 'moment', 'moments')).toBe('3 moments')
    expect(plural(0, 'clip', 'clips')).toBe('0 clips')
  })

  it('formats sizes with decimal units and a decimal point', () => {
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(412_000_000)).toBe('412 MB')
    expect(formatBytes(1_250_000_000)).toBe('1.3 GB')
    expect(formatBytes(4_500)).toBe('4.5 KB')
  })

  it('formats timecodes and clip lengths with a decimal point', () => {
    expect(tc(75.44, 1)).toBe('1:15.4')
    expect(tc(75.44)).toBe('1:15')
    expect(formatSeconds(6)).toBe('6.0 s')
    expect(formatSeconds(4.25)).toBe('4.3 s')
  })

  it('formats relative dates', () => {
    const now = new Date('2026-07-12T20:00:00')
    expect(formatRelative('2026-07-12T19:59:30', now)).toBe('just now')
    expect(formatRelative('2026-07-12T19:15:00', now)).toBe('45 min ago')
    expect(formatRelative('2026-07-12T14:00:00', now)).toBe('6 h ago')
    expect(formatRelative('2026-07-11T23:00:00', now)).toBe('yesterday')
    expect(formatRelative('2026-07-08T12:00:00', now)).toBe('4 days ago')
    expect(formatRelative('2026-06-01T12:00:00', now)).toBe('1 Jun')
  })

  it('formats estimate ranges', () => {
    expect(formatEstimate(30, 60)).toBe('about 30–60 s')
    expect(formatEstimate(60, 120)).toBe('about 1–2 min')
    expect(formatEstimate(40, 95)).toBe('about 40 s to 2 min')
    expect(formatEstimate(120, 130)).toBe('about 2 min')
  })

  it('shortens paths', () => {
    expect(shortenPath('/Users/jan/Movies/Glimpse')).toBe('~/Movies/Glimpse')
    expect(shortenPath('/Volumes/SD/x.mp4')).toBe('/Volumes/SD/x.mp4')
    expect(fileNameOf('/a/b/VID_1.mp4')).toBe('VID_1.mp4')
  })
})

describe('listDe', () => {
  it('joins with commas and “and”', () => {
    expect(listDe([])).toBe('')
    expect(listDe(['3'])).toBe('3')
    expect(listDe(['3', '5'])).toBe('3 and 5')
    expect(listDe(['2', '3', '5'])).toBe('2, 3 and 5')
  })
})
