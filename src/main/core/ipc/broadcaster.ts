// main → renderer events, rate-limited: project updates ≤ 5/s per project and export progress
// ≤ 8/s per project; the latest state is always delivered, terminal export phases immediately.
// Jobs flush a project's pending update before a toast or event that refers to it.

import { IPC_EVENTS } from '@shared/ipc'
import type { ExportPhase, ExportProgress, Project, ToastEvent } from '@shared/types'
import { systemClock, Throttle, type Clock } from '../timing'

export interface BroadcasterOptions {
  send(channel: string, payload: unknown): void
  projectIntervalMs?: number
  exportIntervalMs?: number
  clock?: Clock
  /**
   * keep toasts until markReady(): the renderer subscribes before its first IPC call, so toasts
   * from the start (e.g. a restored project) would otherwise get lost
   */
  holdToasts?: boolean
}

const TERMINAL_PHASES: ReadonlySet<ExportPhase> = new Set(['done', 'error', 'cancelled'])
/** a renderer that never calls in must not make the queue grow forever */
const MAX_HELD_TOASTS = 20

export class Broadcaster {
  private readonly options: Required<BroadcasterOptions>
  private readonly projects = new Map<string, Throttle<Project>>()
  private readonly exports = new Map<string, Throttle<ExportProgress>>()
  private ready: boolean
  private readonly heldToasts: ToastEvent[] = []

  constructor(options: BroadcasterOptions) {
    this.options = {
      projectIntervalMs: 200,
      exportIntervalMs: 125,
      clock: systemClock,
      holdToasts: false,
      ...options
    }
    this.ready = !this.options.holdToasts
  }

  projectUpdated(project: Project): void {
    let throttle = this.projects.get(project.id)
    if (!throttle) {
      throttle = new Throttle(
        this.options.projectIntervalMs,
        (latest) => this.options.send(IPC_EVENTS.projectUpdated, latest),
        this.options.clock
      )
      this.projects.set(project.id, throttle)
    }
    throttle.push(project)
  }

  /** sends the project's pending (throttled) update now – before something that refers to it */
  flushProject(projectId: string): void {
    this.projects.get(projectId)?.flush()
  }

  /** drops a pending update of a deleted project */
  projectDeleted(projectId: string): void {
    this.projects.get(projectId)?.cancel()
    this.projects.delete(projectId)
  }

  exportProgress(event: ExportProgress): void {
    let throttle = this.exports.get(event.projectId)
    if (!throttle) {
      throttle = new Throttle(
        this.options.exportIntervalMs,
        (latest) => this.options.send(IPC_EVENTS.exportProgress, latest),
        this.options.clock
      )
      this.exports.set(event.projectId, throttle)
    }
    if (TERMINAL_PHASES.has(event.phase)) {
      throttle.pushNow(event)
      this.exports.delete(event.projectId)
    } else {
      throttle.push(event)
    }
  }

  toast(event: ToastEvent): void {
    if (this.ready) {
      this.options.send(IPC_EVENTS.toast, event)
    } else if (this.heldToasts.length < MAX_HELD_TOASTS) {
      this.heldToasts.push(event)
    }
  }

  /** the renderer has subscribed (it made its first call): held toasts go out now */
  markReady(): void {
    if (this.ready) return
    this.ready = true
    for (const event of this.heldToasts.splice(0)) this.options.send(IPC_EVENTS.toast, event)
  }

  /** the last window closed: keep toasts (e.g. a failed export) for the next window's first call */
  holdToasts(): void {
    this.ready = false
  }

  dispose(): void {
    for (const throttle of [...this.projects.values(), ...this.exports.values()]) throttle.cancel()
    this.projects.clear()
    this.exports.clear()
  }
}
