// Parser for ffmpeg's machine-readable `-progress pipe:1` output: blocks of `key=value` lines, each
// terminated by `progress=continue` or `progress=end`.

export interface ProgressSample {
  /** output timestamp reached so far, in seconds (null when ffmpeg reported N/A) */
  outTimeSec: number | null
  done: boolean
}

/** "00:01:02.500000" → 62.5 */
export function parseClockTime(value: string): number | null {
  const match = /^(-?)(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(value.trim())
  if (!match) return null
  const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4])
  return match[1] === '-' ? -seconds : seconds
}

/**
 * Seconds from one progress block. Prefers `out_time_us`; `out_time_ms` is also microseconds
 * (a long-standing ffmpeg quirk); `out_time` is the clock-format fallback.
 */
export function outTimeFromFields(fields: ReadonlyMap<string, string>): number | null {
  for (const key of ['out_time_us', 'out_time_ms']) {
    const raw = fields.get(key)
    if (raw !== undefined && /^-?\d+$/.test(raw.trim())) return Number(raw) / 1_000_000
  }
  const clock = fields.get('out_time')
  return clock !== undefined ? parseClockTime(clock) : null
}

/** Incremental parser; feed it stdout chunks, it calls `onSample` once per completed block. */
export function createProgressParser(
  onSample: (sample: ProgressSample) => void
): (chunk: string) => void {
  let pending = ''
  let fields = new Map<string, string>()
  return (chunk: string) => {
    pending += chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim()
      if (key !== 'progress') {
        fields.set(key, value)
        continue
      }
      onSample({ outTimeSec: outTimeFromFields(fields), done: value === 'end' })
      fields = new Map()
    }
  }
}

/** Fraction 0..1 of `outTimeSec` within `durationSec`; -1 when it cannot be computed. */
export function progressFraction(
  outTimeSec: number | null,
  durationSec: number | undefined
): number {
  if (outTimeSec === null || !durationSec || !Number.isFinite(durationSec) || durationSec <= 0) {
    return -1
  }
  return Math.min(1, Math.max(0, outTimeSec / durationSec))
}
