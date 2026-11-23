// User-facing formatting helpers (numbers, sizes, dates, timecodes).

import { formatTimecode } from '@shared/time'

const LOCALE = 'en-GB'

/** "1 video" / "3 videos" */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** decimal (Finder-style) units: 412_000_000 → "412 MB", 1_250_000_000 → "1.3 GB" */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1000) return `${Math.max(0, Math.round(bytes || 0))} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1000
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  const digits = value < 10 ? 1 : 0
  return `${value.toLocaleString(LOCALE, { maximumFractionDigits: digits })} ${units[unit]}`
}

/** position in a video: 75.44 → "1:15.4" (decimals = 1) or "1:15" */
export function tc(seconds: number, decimals: 0 | 1 = 0): string {
  return formatTimecode(seconds, decimals)
}

/** compact clip length: 6 → "6.0 s" */
export function formatSeconds(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  return `${safe.toLocaleString(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`
}

/** "12 Jul 2026" (year omitted when it is the current one) */
export function formatDay(iso: string | null, now: Date = new Date()): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const sameYear = date.getFullYear() === now.getFullYear()
  return date.toLocaleDateString(LOCALE, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' })
  })
}

/** "21:14" */
export function formatClock(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
}

/** "Sat, 12 Jul · 21:14" */
export function formatRecordedAt(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'Recording time unknown'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Recording time unknown'
  const weekday = date.toLocaleDateString(LOCALE, { weekday: 'short' })
  return `${weekday}, ${formatDay(iso, now)} · ${formatClock(iso)}`
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", else the date */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  const diffSec = (now.getTime() - date.getTime()) / 1000
  if (!Number.isFinite(diffSec)) return ''
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`
  const startOfDay = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (dayDiff === 0) return `${Math.floor(diffSec / 3600)} h ago`
  if (dayDiff === 1) return 'yesterday'
  if (dayDiff < 7) return `${dayDiff} days ago`
  return formatDay(iso, now)
}

/** "/Users/jan/Movies/x" → "~/Movies/x" */
export function shortenPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~')
}

export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** coarse range for estimates: (30, 60) → "about 30–60 s", (60, 120) → "about 1–2 min" */
export function formatEstimate(lowSec: number, highSec: number): string {
  const round10 = (sec: number): number => Math.max(10, Math.round(sec / 10) * 10)
  const minutes = (sec: number): number => Math.max(1, Math.round(sec / 60))
  const low = Math.max(0, lowSec)
  const high = Math.max(low, highSec)
  const range = (a: number, b: number, unit: string): string =>
    a === b ? `about ${a} ${unit}` : `about ${a}–${b} ${unit}`
  if (high <= 60) return range(round10(low), round10(high), 's')
  if (low >= 60) return range(minutes(low), minutes(high), 'min')
  return `about ${round10(low)} s to ${minutes(high)} min`
}

/** enumeration: ["3"] → "3", ["3", "5"] → "3 and 5", ["2", "3", "5"] → "2, 3 and 5" */
export function listDe(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}
