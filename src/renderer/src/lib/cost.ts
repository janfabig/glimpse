// Rough cost of analysing one video of about 5 minutes when billing is enabled, from
// docs/research/gemini.md ("Cost hints for the UI" for 3.8 Flash, the price table for the others).
// Without billing the analysis costs nothing but the free quota is small.

/** cents per 5-minute video on Gemini 3.8 Flash at $0.75 / $3.75 per 1M tokens, [low, high] */
const FLASH_CENTS = [3, 6]

interface ModelPricing {
  /** price relative to 3.8 Flash at $0.75 / $3.75 (video input dominates the bill) */
  factor: number
  /** a promotional price ends: from this day (UTC) on, `laterFactor` applies */
  priceRiseOn?: string
  laterFactor?: number
  /** free quota in requests per day, when its size is known (3.6 Flash: unknown, Argon: none) */
  free?: number
}

const PRICING: Record<string, ModelPricing> = {
  // $0.75 / $3.75 until 2026-12-31, then $1.50 / $7.50; ≈ 20 requests per day for free
  'gemini-3.8-flash': { factor: 1, priceRiseOn: '2027-01-01', laterFactor: 2, free: 20 },
  // priced like 3.8 Flash
  'gemini-3.6-flash': { factor: 1, priceRiseOn: '2027-01-01', laterFactor: 2 },
  // $0.30 / $2.50: input at 40 %, output at 67 % of 3.8 Flash; ≈ 500 requests per day for free
  'gemini-3.5-flash-lite': { factor: 0.5, free: 500 },
  // $2 / $10 until 2026-11-30, then $4 / $20; paid only
  'gemini-4-argon': { factor: 8 / 3, priceRiseOn: '2026-12-01', laterFactor: 16 / 3 }
}

function roundCents(cents: number): number {
  if (cents < 1) return 1
  return cents < 20 ? Math.round(cents) : Math.round(cents / 5) * 5
}

/**
 * Prompt step footer: "with billing about 3–6 cents per 5-minute video" – null for a model without known
 * prices
 */
export function costHint(model: string | undefined, now: Date = new Date()): string | null {
  const pricing = model ? PRICING[model] : undefined
  if (!pricing) return null
  const later =
    pricing.priceRiseOn !== undefined &&
    pricing.laterFactor !== undefined &&
    now.getTime() >= Date.parse(`${pricing.priceRiseOn}T00:00:00Z`)
  const factor = later ? (pricing.laterFactor ?? pricing.factor) : pricing.factor
  const [low, high] = FLASH_CENTS.map((cents) => roundCents(cents * factor))
  const amount = low === high ? `${low} ${low === 1 ? 'cent' : 'cents'}` : `${low}–${high} cents`
  return `with billing about ${amount} per 5-minute video`
}

/**
 * Prompt step footer: the free daily quota of `model` (third-party figure, hence "about") is smaller
 * than the number of videos to analyse – null when it is enough, unknown or the model is paid only
 */
export function freeQuotaWarning(model: string | undefined, videos: number): string | null {
  const free = model ? PRICING[model]?.free : undefined
  if (free === undefined || videos <= free) return null
  const advice =
    model === 'gemini-3.5-flash-lite'
      ? 'Turn on billing.'
      : 'Switch to Gemini 3.5 Flash-Lite in Settings or turn on billing.'
  return `Without billing, the free quota (about ${free} analyses a day) is not enough for all of them. ${advice}`
}
