// AI module: Gemini analyzer + deterministic fake (see docs/ARCHITECTURE.md §7).
import type { Analyzer } from '../contracts'
import { createFakeAnalyzer } from './fake'
import { createGeminiAnalyzer, type GeminiDeps } from './gemini'
import type { AnalyzerLogger } from './logger'

export { DEFAULT_MODEL, MODEL_CATALOG } from './models'
export type { AnalyzerLogger } from './logger'
export type { GeminiDeps } from './gemini'

export interface AnalyzerOptions {
  /** true → deterministic fake (HC_FAKE_AI=1, tests, demos without API key) */
  fake: boolean
  /** diagnostics such as retries, upload fallbacks, cleanup problems (never the API key); default: console */
  logger?: AnalyzerLogger
  /** fake only: duration of one simulated stage in ms (default 450) */
  fakeStageMs?: number
  /** Gemini only: test seams (SDK client factory, fetch for uploads, clock, sleep, …) */
  gemini?: Partial<GeminiDeps>
}

export function createAnalyzer(options: AnalyzerOptions): Analyzer {
  if (options.fake) return createFakeAnalyzer({ stageMs: options.fakeStageMs })
  return createGeminiAnalyzer({ logger: options.logger, ...options.gemini })
}
