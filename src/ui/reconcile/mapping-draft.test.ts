import { describe, expect, it } from 'vitest'
import { draftFromMapping, emptyDraft, toMapping } from './mapping-draft'

describe('toMapping', () => {
  it('asks for every required choice, including an explicit date format', () => {
    expect(toMapping(emptyDraft(), ['Date', 'Amount'])).toEqual({
      ok: false,
      issues: ['Choose the date column', 'Choose the amount column', 'Choose the date format'],
    })
  })

  it('builds a split mapping with optional columns left out', () => {
    const draft = { ...emptyDraft(), dateColumn: 'Date', dateFormat: 'DD/MM/YYYY' as const, amountKind: 'split' as const, inColumn: 'Credit', outColumn: 'Debit', amountColumn: 'stale' }
    const outcome = toMapping(draft, ['Date', 'Credit', 'Debit'])
    expect(outcome).toMatchObject({
      ok: true,
      mapping: { amount: { kind: 'split', inColumn: 'Credit', outColumn: 'Debit', unused: 'blank' }, reference: null, description: null },
    })
  })
})

describe('draftFromMapping', () => {
  it('round-trips through toMapping', () => {
    const draft = { ...emptyDraft(), dateColumn: 'Date', dateFormat: 'DD-Mon-YYYY' as const, amountKind: 'split' as const, inColumn: 'In', outColumn: 'Out', parentheses: true, description: 'Memo' }
    const outcome = toMapping(draft, ['Date', 'In', 'Out', 'Memo'])
    if (!outcome.ok) throw new Error(outcome.issues.join())
    expect(toMapping(draftFromMapping(outcome.mapping), ['Date', 'In', 'Out', 'Memo'])).toEqual(outcome)
  })
})
