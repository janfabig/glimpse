// User-facing texts of the ai module. Diagnostics go to the logger.
// Terms: "API key"; "billing", which the user finds under "Billing" in Google AI Studio.

export const MESSAGES = {
  cancelled: 'Cancelled.',
  emptyKey: 'Enter an API key.',
  keyOk: (count: number): string =>
    `Connected: ${count} ${count === 1 ? 'model' : 'models'} available`,
  /** key test: the key is not stored yet, so the way out is copying it again */
  keyRejected: 'Google rejected this API key. Copy it again in full in AI Studio.',
  /** during an analysis: the stored key was rejected */
  auth: 'Google rejected your API key. Check it in Settings.',
  billing:
    'Your Gemini credit is used up. Top it up in Google AI Studio under Billing and try again.',
  model: (label: string | null): string =>
    label
      ? `The model “${label}” is not available. Choose another model in Settings.`
      : 'The selected model is not available. Choose another model in Settings.',
  quotaMinute: 'Gemini is getting too many requests right now. Wait a minute and try again.',
  /** `alternative`: label of a model with a larger free daily quota, null when there is none */
  quotaDay: (alternative: string | null): string =>
    alternative
      ? `Your daily Gemini quota is used up. Try again tomorrow, switch to ${alternative} in Settings or turn on billing in Google AI Studio.`
      : 'Your daily Gemini quota is used up. Try again tomorrow or turn on billing in Google AI Studio.',
  /** `alternative`: label of a model with a free tier */
  paidOnly: (label: string | null, alternative: string): string =>
    `${label ? `“${label}”` : 'This model'} only works with billing turned on. Turn on billing in Google AI Studio or switch to ${alternative} in Settings.`,
  network: 'No connection to Gemini. Check your internet connection and try again.',
  timeout: 'Gemini did not answer in time. Try again.',
  server: 'Gemini is overloaded or cannot be reached right now. Try again in a few minutes.',
  safety: 'Gemini refused to analyse this video for safety reasons.',
  invalidResponse: 'Gemini did not return a usable answer. Try again.',
  processing: 'Gemini could not process the video. Try again.',
  processingTimeout: 'Gemini did not process the video in time. Try again.',
  videoNotSeen: 'Gemini could not read the video properly. Try again.',
  fileGone:
    'The uploaded video is no longer available at Gemini. Try again and it will be uploaded again.',
  upload: 'The video could not be uploaded to Gemini. Try again.',
  proxyMissing: 'The preview file of the video is missing. Recreate the preview.',
  rejected: (detail: string): string => `Gemini rejected the request: ${detail}`,
  unknown: 'An unexpected error occurred during the analysis. Try again.',
  fakeProcessing: 'Gemini could not process the video (test mode).'
} as const
