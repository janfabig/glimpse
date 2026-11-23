// Small pure helpers for main, the ai module and the renderer.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100
}
