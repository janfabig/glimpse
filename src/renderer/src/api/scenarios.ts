// Mock scenarios (?mock=1&scenario=…) used by `npm run ui:snap` and browser development.

export const MOCK_SCENARIOS = [
  'home',
  'nokey',
  'noffmpeg',
  /** ffmpeg is installed but does not start */
  'ffmpegbroken',
  /** a stored API key that can no longer be decrypted (Settings open) */
  'keyunreadable',
  /** Google rejected the stored key during an analysis (Settings open) */
  'keyrejected',
  'videos',
  /** three previews failed: only the filmstrip of one, one original is gone, one not converted */
  'previewfailed',
  'brief',
  'analyzing',
  /** the run ended with the daily quota used up for three videos */
  'analysisfailed',
  'review',
  'export',
  'exporting',
  'done',
  'settings'
] as const

export type MockScenario = (typeof MOCK_SCENARIOS)[number]

export function parseScenario(value: string | null): MockScenario {
  return (MOCK_SCENARIOS as readonly string[]).includes(value ?? '')
    ? (value as MockScenario)
    : 'home'
}
