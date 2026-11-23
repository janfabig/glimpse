import { AnalyzerError, type Analyzer } from '../contracts'
import { LOG_HINT } from './errors'

export const ANALYZER_UNAVAILABLE_MESSAGE = `The analysis with Gemini is not available right now. ${LOG_HINT}`

/** stands in when the analyzer cannot be created, so the rest of the app keeps working */
export function createUnavailableAnalyzer(): Analyzer {
  const unavailable = (): AnalyzerError =>
    new AnalyzerError('unknown', ANALYZER_UNAVAILABLE_MESSAGE)
  return {
    analyze: async () => {
      throw unavailable()
    },
    listModels: async () => {
      throw unavailable()
    },
    testKey: async () => ({ ok: false, message: ANALYZER_UNAVAILABLE_MESSAGE }),
    deleteRemoteFile: async () => undefined
  }
}
