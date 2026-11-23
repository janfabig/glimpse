// Time helpers shared by main and renderer.

/**
 * Parses a timestamp into seconds. Accepts "SS", "M:SS", "MM:SS", "MM:SS.s", "H:MM:SS(.s)",
 * plain numbers (seconds) and numeric strings with an optional "s" suffix ("12.5s").
 * Returns null for anything unparseable or negative.
 */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null
  if (typeof value !== 'string') return null
  const s = value.trim().replace(/,/g, '.')
  if (s === '') return null
  const plain = /^(\d+(?:\.\d+)?)\s*s?$/i.exec(s)
  if (plain) return Number(plain[1])
  const parts = s.split(':')
  if (parts.length < 2 || parts.length > 3) return null
  if (!parts.every((p, i) => (i === parts.length - 1 ? /^\d+(\.\d+)?$/ : /^\d+$/).test(p))) {
    return null
  }
  const nums = parts.map(Number)
  const [h, m, sec] = parts.length === 3 ? nums : [0, nums[0], nums[1]]
  if (sec >= 60 || (parts.length === 3 && m >= 60)) return null
  return h * 3600 + m * 60 + sec
}

/** 75.4 → "1:15", 3725 → "1:02:05"; with decimals=1: 75.4 → "1:15.4" */
export function formatTimecode(seconds: number, decimals: 0 | 1 = 0): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const factor = decimals === 1 ? 10 : 1
  const rounded = Math.round(safe * factor) / factor
  const h = Math.floor(rounded / 3600)
  const m = Math.floor((rounded % 3600) / 60)
  const s = rounded % 60
  const sStr =
    decimals === 1 ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sStr}` : `${m}:${sStr}`
}

/** human duration: 42 → "42 s", 95 → "1:35 min" */
export function formatDurationDe(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return `${total} s`
  return `${formatTimecode(total)} min`
}
