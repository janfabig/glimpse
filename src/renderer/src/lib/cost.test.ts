import { describe, expect, it } from 'vitest'
import { MODEL_CATALOG } from '../../../main/ai/models'
import { costHint, freeQuotaWarning } from './cost'

const NOV = new Date('2026-11-01T12:00:00Z')
const JAN = new Date('2027-01-15T12:00:00Z')

describe('analysis cost hints', () => {
  it('uses the researched figure for 3.8 Flash', () => {
    expect(costHint('gemini-3.8-flash', NOV)).toBe(
      'with billing about 3–6 cents per 5-minute video'
    )
  })

  it('scales the other models by the price table, including the end of promotional prices', () => {
    const cents = (model: string, now: Date): string | undefined =>
      /about (.+) cents/.exec(costHint(model, now) ?? '')?.[1]
    expect(cents('gemini-3.8-flash', JAN)).toBe('6–12')
    expect(cents('gemini-3.6-flash', NOV)).toBe('3–6')
    expect(cents('gemini-3.5-flash-lite', NOV)).toBe('2–3')
    expect(cents('gemini-4-argon', NOV)).toBe('8–16')
    expect(cents('gemini-4-argon', new Date('2026-12-01T00:00:00Z'))).toBe('16–30')
  })

  it('knows every model of the catalog and says nothing about unknown ones', () => {
    for (const model of MODEL_CATALOG) expect(costHint(model.id, NOV), model.id).not.toBeNull()
    expect(costHint('gemini-9-experimental', NOV)).toBeNull()
    expect(costHint(undefined, NOV)).toBeNull()
  })

  it('warns in the Prompt step when more videos wait than the free daily quota allows', () => {
    expect(freeQuotaWarning('gemini-3.8-flash', 20)).toBeNull()
    expect(freeQuotaWarning('gemini-3.8-flash', 21)).toBe(
      'Without billing, the free quota (about 20 analyses a day) is not enough for all of them. ' +
        'Switch to Gemini 3.5 Flash-Lite in Settings or turn on billing.'
    )
    // the suggested label must stay main's catalog name
    expect(MODEL_CATALOG.some((m) => m.displayName === 'Gemini 3.5 Flash-Lite')).toBe(true)
    // Flash-Lite is the suggestion itself
    expect(freeQuotaWarning('gemini-3.5-flash-lite', 25)).toBeNull()
    expect(freeQuotaWarning('gemini-3.5-flash-lite', 501)).toBe(
      'Without billing, the free quota (about 500 analyses a day) is not enough for all of them. ' +
        'Turn on billing.'
    )
    // quota of unknown size, paid only, unknown model: nothing to compare with
    for (const model of [
      'gemini-3.6-flash',
      'gemini-4-argon',
      'gemini-9-experimental',
      undefined
    ]) {
      expect(freeQuotaWarning(model, 100), String(model)).toBeNull()
    }
  })
})
