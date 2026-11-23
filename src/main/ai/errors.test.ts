import { ApiError } from '@google/genai'
import { describe, expect, it } from 'vitest'
import { AnalyzerError } from '../contracts'
import {
  apiErrorInfo,
  classifyError,
  ContentProblem,
  isFileNotFound,
  isRetryable,
  redactSecrets,
  toAnalyzerError
} from './errors'
import { MESSAGES } from './messages'
import { abortError, apiError, networkError } from './testSupport'

const retryInfo = (delay: string): unknown => ({
  '@type': 'type.googleapis.com/google.rpc.RetryInfo',
  retryDelay: delay
})
const quotaFailure = (quotaId: string): unknown => ({
  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
  violations: [
    { quotaMetric: 'generativelanguage.googleapis.com/generate_content_requests', quotaId }
  ]
})
const errorInfo = (reason: string): unknown => ({
  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
  reason,
  domain: 'googleapis.com'
})
const unknownModel = (model: string): ApiError =>
  apiError(404, {
    message: `models/${model} is not found for API version v1beta, or is not supported for generateContent.`,
    status: 'NOT_FOUND'
  })
const fileGone = (): ApiError =>
  apiError(403, {
    message: 'You do not have permission to access the File abc123 or it may not exist.',
    status: 'PERMISSION_DENIED'
  })
const keyBlocked = (): ApiError =>
  apiError(403, {
    message:
      'Requests to this API generativelanguage.googleapis.com method google.ai.generativelanguage.v1beta.FileService.CreateFile are blocked.',
    status: 'PERMISSION_DENIED',
    details: [errorInfo('API_KEY_SERVICE_BLOCKED')]
  })

describe('apiErrorInfo', () => {
  it('reads status, message, retry hint, quota ids and reasons from the JSON body', () => {
    const err = apiError(429, {
      message: 'Resource has been exhausted (e.g. check quota).',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        quotaFailure('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'),
        retryInfo('33s'),
        errorInfo('RATE_LIMIT_EXCEEDED')
      ]
    })
    expect(apiErrorInfo(err)).toEqual({
      status: 429,
      apiStatus: 'RESOURCE_EXHAUSTED',
      message: 'Resource has been exhausted (e.g. check quota).',
      reasons: ['RATE_LIMIT_EXCEEDED'],
      quotaIds: ['GenerateRequestsPerMinutePerProjectPerModel-FreeTier'],
      retryAfterMs: 33_000
    })
  })

  it('understands the streaming error format and fractional delays', () => {
    const body = JSON.stringify({
      error: { code: 503, message: 'overloaded', details: [retryInfo('1.5s')] }
    })
    const err = new ApiError({
      message: `got status: 503 Service Unavailable. ${body}`,
      status: 503
    })
    expect(apiErrorInfo(err)).toMatchObject({
      status: 503,
      message: 'overloaded',
      retryAfterMs: 1_500
    })
  })

  it('keeps non-JSON messages and ignores other errors', () => {
    expect(apiErrorInfo(new ApiError({ message: 'Bad Gateway', status: 502 }))).toMatchObject({
      status: 502,
      message: 'Bad Gateway'
    })
    expect(apiErrorInfo(new Error('x'))).toBeNull()
    expect(apiErrorInfo('x')).toBeNull()
  })
})

describe('classifyError', () => {
  it.each([
    [
      'invalid key (400)',
      apiError(400, {
        message: 'API key not valid. Please pass a valid API key.',
        details: [errorInfo('API_KEY_INVALID')]
      }),
      'auth'
    ],
    [
      'expired key',
      apiError(400, { message: 'API key expired. Please renew the API key.' }),
      'auth'
    ],
    ['401', apiError(401), 'auth'],
    ['403', apiError(403, { message: 'Permission denied' }), 'auth'],
    ['403 key restricted to other methods', keyBlocked(), 'auth'],
    ['402', apiError(402), 'billing'],
    [
      '404',
      apiError(404, { message: 'models/gemini-9 is not found for API version v1beta' }),
      'model'
    ],
    ['404 for a model by name', apiError(404, { message: 'Model gemini-9 not found.' }), 'model'],
    ['404 naming no model', apiError(404, { message: 'Not Found' }), 'rejected'],
    ['403 for a missing file', fileGone(), 'file'],
    ['404 for a missing file', apiError(404, { message: 'files/abc123 was not found.' }), 'file'],
    [
      '400 unknown model',
      apiError(400, { message: 'Model gemini-x is not supported for generateContent.' }),
      'model'
    ],
    [
      '429 per minute',
      apiError(429, { details: [quotaFailure('GenerateRequestsPerMinutePerProjectPerModel')] }),
      'quota-minute'
    ],
    [
      '429 per day',
      apiError(429, {
        details: [quotaFailure('GenerateRequestsPerDayPerProjectPerModel-FreeTier')]
      }),
      'quota-day'
    ],
    [
      '429 limit 0',
      apiError(429, {
        message:
          'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-4-argon'
      }),
      'quota-paid-only'
    ],
    ['408', apiError(408), 'timeout'],
    ['500', apiError(500), 'server'],
    ['503', apiError(503, { message: 'The model is overloaded.' }), 'server'],
    ['504', apiError(504), 'server'],
    ['other 400', apiError(400, { message: 'Request contains an invalid argument.' }), 'rejected'],
    ['fetch failed', networkError('ECONNRESET'), 'network'],
    ['DNS failure', networkError('ENOTFOUND'), 'network'],
    ['fetch failed without cause', new TypeError('fetch failed'), 'network'],
    ['socket code', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'network'],
    ['body interrupted', new TypeError('terminated'), 'network'],
    ['SDK timeout', abortError(), 'timeout'],
    ['bug', new RangeError('oops'), 'unknown']
  ])('%s → %s', (_label, err, kind) => {
    expect(classifyError(err).kind).toBe(kind)
  })

  it('treats aborts and errors after our own abort as cancellation', () => {
    const controller = new AbortController()
    controller.abort()
    expect(classifyError(abortError(), controller.signal).kind).toBe('cancelled')
    expect(classifyError(networkError(), controller.signal).kind).toBe('cancelled')
  })

  it('passes our own AnalyzerErrors through as final', () => {
    expect(classifyError(new AnalyzerError('safety', 'x')).kind).toBe('final')
    expect(classifyError(new AnalyzerError('cancelled', 'x')).kind).toBe('cancelled')
  })

  it('keeps retry hints for per-minute quotas and server errors', () => {
    expect(classifyError(apiError(429, { details: [retryInfo('20s')] })).retryAfterMs).toBe(20_000)
    expect(classifyError(apiError(503, { details: [retryInfo('5s')] })).retryAfterMs).toBe(5_000)
  })

  it('marks only transient failures as retryable', () => {
    const retryable = ['network', 'timeout', 'server', 'quota-minute']
    for (const kind of [
      'cancelled',
      'final',
      'auth',
      'billing',
      'model',
      'file',
      'quota-minute',
      'quota-day',
      'quota-paid-only',
      'network',
      'timeout',
      'server',
      'rejected',
      'unknown'
    ] as const) {
      expect(isRetryable({ kind, detail: '' })).toBe(retryable.includes(kind))
    }
  })
})

describe('isFileNotFound', () => {
  it.each([
    ['any 404', apiError(404), true],
    ['a 403 naming the file', fileGone(), true],
    ['a plain 403', apiError(403, { message: 'Permission denied' }), false],
    ['a key restriction', keyBlocked(), false],
    ['an invalid key', apiError(400, { message: 'API key not valid.' }), false],
    ['a server error', apiError(503), false],
    ['a network error', networkError(), false],
    ['our own errors', new AnalyzerError('processing', 'x'), false]
  ])('%s → %s', (_label, err, expected) => {
    expect(isFileNotFound(err)).toBe(expected)
  })
})

describe('toAnalyzerError', () => {
  it.each([
    [
      apiError(400, { details: [errorInfo('API_KEY_INVALID')], message: 'API key not valid.' }),
      'auth',
      false,
      'Google rejected your API key. Check it in Settings.'
    ],
    [
      apiError(402),
      'quota',
      false,
      'Your Gemini credit is used up. Top it up in Google AI Studio under Billing and try again.'
    ],
    [
      apiError(429),
      'quota',
      true,
      'Gemini is getting too many requests right now. Wait a minute and try again.'
    ],
    [
      apiError(429, { message: 'You exceeded your current quota per day.' }),
      'quota',
      false,
      'Your daily Gemini quota is used up. Try again tomorrow, switch to Gemini 3.5 Flash-Lite in Settings or turn on billing in Google AI Studio.'
    ],
    [
      networkError(),
      'network',
      true,
      'No connection to Gemini. Check your internet connection and try again.'
    ],
    [abortError(), 'network', true, 'Gemini did not answer in time. Try again.'],
    [
      apiError(503),
      'network',
      true,
      'Gemini is overloaded or cannot be reached right now. Try again in a few minutes.'
    ],
    [
      new Error('boom'),
      'unknown',
      true,
      'An unexpected error occurred during the analysis. Try again.'
    ]
  ])('maps %s to %s', (err, code, retryable, message) => {
    const mapped = toAnalyzerError(err, { model: 'gemini-3.8-flash' })
    expect(mapped).toBeInstanceOf(AnalyzerError)
    expect(mapped.code).toBe(code)
    expect(mapped.retryable).toBe(retryable)
    expect(mapped.message).toBe(message)
    expect(mapped.cause).toBe(err)
  })

  it('names the model in model and paid-only errors', () => {
    const argon = toAnalyzerError(unknownModel('gemini-4-argon'), { model: 'gemini-4-argon' })
    expect(argon.code).toBe('model')
    expect(argon.retryable).toBe(false)
    expect(argon.message).toBe(
      'The model “Gemini 4 Argon” is not available. Choose another model in Settings.'
    )
    expect(
      toAnalyzerError(unknownModel('gemini-9-ultra'), { model: 'gemini-9-ultra' }).message
    ).toContain('“gemini-9-ultra”')
    expect(toAnalyzerError(unknownModel('gemini-9')).message).toBe(
      'The selected model is not available. Choose another model in Settings.'
    )
    const paidOnly = toAnalyzerError(apiError(429, { message: 'limit: 0' }), {
      model: 'gemini-4-argon'
    })
    expect(paidOnly.code).toBe('quota')
    expect(paidOnly.retryable).toBe(false)
    expect(paidOnly.message).toBe(
      '“Gemini 4 Argon” only works with billing turned on. Turn on billing in Google AI Studio or switch to Gemini 3.8 Flash in Settings.'
    )
  })

  it('suggests a model the user is not already on', () => {
    const daily = apiError(429, { message: 'You exceeded your current quota per day.' })
    expect(toAnalyzerError(daily, { model: 'gemini-3.5-flash-lite' }).message).toBe(
      'Your daily Gemini quota is used up. Try again tomorrow or turn on billing in Google AI Studio.'
    )
    expect(toAnalyzerError(daily, { model: 'gemini-4-argon' }).message).toContain(
      'switch to Gemini 3.5 Flash-Lite in Settings'
    )
    const paidOnly = apiError(429, { message: 'Quota exceeded, limit: 0' })
    expect(toAnalyzerError(paidOnly, { model: 'gemini-3.8-flash' }).message).toBe(
      '“Gemini 3.8 Flash” only works with billing turned on. Turn on billing in Google AI Studio or switch to Gemini 3.5 Flash-Lite in Settings.'
    )
    expect(toAnalyzerError(paidOnly).message).toBe(
      'This model only works with billing turned on. Turn on billing in Google AI Studio or switch to Gemini 3.8 Flash in Settings.'
    )
  })

  it('keeps the quota and billing texts short enough for 2–3 lines and in the app’s own terms', () => {
    const texts = [
      MESSAGES.billing,
      MESSAGES.quotaDay('Gemini 3.5 Flash-Lite'),
      MESSAGES.quotaDay(null),
      MESSAGES.paidOnly('Gemini 4 Argon', 'Gemini 3.8 Flash')
    ]
    for (const text of texts) {
      expect(text.length).toBeLessThanOrEqual(200)
      // "Billing" only as the name of the page in Google AI Studio; a key is always the "API key"
      expect(text.replaceAll('under Billing', '')).not.toMatch(/Billing|(?<!API )key/)
    }
  })

  it('shows the API message for other rejected requests', () => {
    const mapped = toAnalyzerError(
      apiError(400, { message: 'Request contains an invalid argument.' })
    )
    expect(mapped.code).toBe('unknown')
    expect(mapped.retryable).toBe(false)
    expect(mapped.message).toBe(
      'Gemini rejected the request: Request contains an invalid argument.'
    )
    // a 404 that names no model does not blame the model
    const notFound = toAnalyzerError(apiError(404, { message: 'Not Found' }), {
      model: 'gemini-3.8-flash'
    })
    expect(notFound.code).toBe('unknown')
    expect(notFound.message).toBe('Gemini rejected the request: Not Found')
  })

  it('maps a vanished file to a retryable processing error, not to the key or the model', () => {
    for (const err of [fileGone(), apiError(404, { message: 'File abc123 not found.' })]) {
      const mapped = toAnalyzerError(err, { model: 'gemini-4-argon' })
      expect(mapped.code).toBe('processing')
      expect(mapped.retryable).toBe(true)
      expect(mapped.message).toBe(MESSAGES.fileGone)
      expect(mapped.cause).toBe(err)
    }
  })

  it('returns AnalyzerErrors unchanged and prefers cancellation', () => {
    const own = new AnalyzerError('safety', 'x')
    expect(toAnalyzerError(own)).toBe(own)
    const controller = new AbortController()
    controller.abort()
    const cancelled = toAnalyzerError(own, { signal: controller.signal })
    expect(cancelled.code).toBe('cancelled')
    expect(cancelled.message).toBe('Cancelled.')
  })

  it('maps content problems', () => {
    expect(new ContentProblem('format', 'x').toAnalyzerError()).toMatchObject({
      code: 'invalid-response',
      retryable: true,
      message: 'Gemini did not return a usable answer. Try again.'
    })
    expect(new ContentProblem('video-not-seen', 'x').toAnalyzerError()).toMatchObject({
      code: 'processing',
      message: 'Gemini could not read the video properly. Try again.'
    })
  })
})

describe('redactSecrets', () => {
  it('removes API keys from texts', () => {
    const key = 'AIzaSyD-abcdefghijklmnopqrstuvwxyz012345'
    expect(redactSecrets(`url?key=${key}&x=1`)).toBe('url?key=AIza…&x=1')
    const failure = classifyError(apiError(400, { message: `Invalid argument ${key}` }))
    expect(failure.detail).not.toContain(key)
    expect(
      toAnalyzerError(apiError(400, { message: `Invalid argument ${key}` })).message
    ).not.toContain(key)
  })
})
