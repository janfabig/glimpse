// Diagnostics of the ai module (English). Never pass the API key to a logger.

export interface AnalyzerLogger {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
}

export const consoleLogger: AnalyzerLogger = {
  info: (message, data) => console.info(`[ai] ${message}`, ...(data ? [data] : [])),
  warn: (message, data) => console.warn(`[ai] ${message}`, ...(data ? [data] : []))
}
