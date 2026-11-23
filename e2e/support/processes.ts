// Leaves nothing running: Electron helpers and ffmpeg/ffprobe children of a test are found by the
// test's temp folder in their command line (proxies, renders and the profile all live there).

import { execFileSync } from 'node:child_process'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** pids of processes whose command line contains `fragment` (never this process) */
export function processesMatching(fragment: string): number[] {
  try {
    const out = execFileSync('pgrep', ['-f', escapeRegExp(fragment)], { encoding: 'utf8' })
    return out
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
  } catch {
    // pgrep exits with 1 when nothing matches
    return []
  }
}

/** ffmpeg/ffprobe processes whose command line contains `fragment` */
export function ffmpegProcesses(fragment: string): number[] {
  return processesMatching(fragment).filter((pid) => {
    try {
      const command = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' })
      return /ff(mpeg|probe)/.test(command)
    } catch {
      return false
    }
  })
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** SIGKILLs every process whose command line contains `fragment`; returns their pids */
export function killMatching(fragment: string): number[] {
  const pids = processesMatching(fragment)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  return pids
}
