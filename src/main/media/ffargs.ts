/**
 * Input options of every ffprobe run and of every ffmpeg input the user picked: local files only,
 * and only the demuxers of VIDEO_EXTENSIONS (mov: mp4/mov/m4v/3gp, matroska: mkv/webm, avi,
 * mpegts: mts), so a playlist or concat list named .mp4 cannot make ffmpeg read another file or a URL.
 */
export const LOCAL_VIDEO_INPUT = [
  '-protocol_whitelist',
  'file',
  '-format_whitelist',
  'mov,matroska,avi,mpegts'
] as const

/** Seconds for ffmpeg arguments: ≥ 0, at most 6 decimals, never exponent notation. */
export function formatSeconds(seconds: number): string {
  return String(Math.round(Math.max(0, seconds) * 1e6) / 1e6)
}

/** time limit of the poster run: one frame, like the probe's */
export const POSTER_TIMEOUT_MS = 60_000

/**
 * Time limit of an ffmpeg run over a whole video (proxy, sprite): 20 times its length plus two
 * minutes – far beyond the slowest Mac, but a run that hangs (a file that never answers) ends.
 */
export function videoRunTimeoutMs(durationSec: number): number {
  return (120 + 20 * (durationSec > 0 ? durationSec : 0)) * 1000
}
