// The slice of the @google/genai client the analyzer uses – narrow so tests can fake it.
import { createHash } from 'node:crypto'
import {
  GoogleGenAI,
  type DeleteFileParameters,
  type File as GeminiFile,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type GetFileParameters,
  type ListModelsParameters,
  type Model,
  type UploadFileParameters
} from '@google/genai'

/** the fields of a generateContent response we read (the SDK returns a class with getters) */
export type GenerateResult = Pick<
  GenerateContentResponse,
  'candidates' | 'promptFeedback' | 'usageMetadata'
>

export interface GenAiClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<GenerateResult>
    list(params?: ListModelsParameters): Promise<AsyncIterable<Model>>
  }
  files: {
    upload(params: UploadFileParameters): Promise<GeminiFile>
    get(params: GetFileParameters): Promise<GeminiFile>
    delete(params: DeleteFileParameters): Promise<unknown>
  }
}

export const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com'
/** client default; generateContent sets its own per-model timeout (Argon: 20 min) */
const CLIENT_TIMEOUT_MS = 10 * 60_000

/** Gemini Developer API client. No retryOptions → the SDK does not retry; our code does. */
export function createGenAiClient(apiKey: string): GenAiClient {
  return new GoogleGenAI({
    apiKey,
    enterprise: false,
    // pinned: the SDK would otherwise follow GOOGLE_GEMINI_BASE_URL, which any local program can set
    httpOptions: { baseUrl: DEFAULT_BASE_URL, timeout: CLIENT_TIMEOUT_MS }
  })
}

/** stable, non-reversible id of an API key for map keys */
export function keyId(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16)
}

/** One client per API key (the last few keys are kept, e.g. while testing a new key). */
export function createClientCache(
  factory: (apiKey: string) => GenAiClient,
  size = 3
): (apiKey: string) => GenAiClient {
  const clients = new Map<string, GenAiClient>()
  return (apiKey) => {
    const id = keyId(apiKey)
    const cached = clients.get(id)
    if (cached) {
      clients.delete(id)
      clients.set(id, cached)
      return cached
    }
    const client = factory(apiKey)
    clients.set(id, client)
    if (clients.size > size) {
      const oldest = clients.keys().next()
      if (!oldest.done) clients.delete(oldest.value)
    }
    return client
  }
}
