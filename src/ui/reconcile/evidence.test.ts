import { describe, expect, it } from 'vitest'
import { DEFAULT_MATCHING } from '../../reconciliation/types'
import type { SuggestionItem, TransactionView } from '../../worker/reconcile-protocol'
import { competitionText, dateEvidence, evidenceText } from './evidence'

function view(reference: string | null): TransactionView {
  return { key: 'k', side: 'bank', recordNumber: 1, span: null, date: '2026-09-01', amount: '-10.00', direction: 'out', reference, original: { date: '', amount: [], reference, description: null } }
}

function item(overrides: Partial<SuggestionItem>): SuggestionItem {
  return { group: 0, groupBank: 1, groupBooks: 1, groupPairs: 1, unique: true, tier: 3, gap: 0, bank: view(null), books: view(null), ...overrides }
}

describe('evidence wording', () => {
  it('states the date gap in days and direction', () => {
    expect(dateEvidence(0)).toBe('same date')
    expect(dateEvidence(2)).toBe('bank date 2 days after books')
    expect(dateEvidence(-1)).toBe('bank date 1 day before books')
  })

  it('says how references were used', () => {
    expect(evidenceText(item({ gap: 2 }), DEFAULT_MATCHING)).toBe('Amount exact; bank date 2 days after books; references not compared.')
    const shared = { ...DEFAULT_MATCHING, referencesShared: true }
    expect(evidenceText(item({ tier: 1, bank: view('A'), books: view('A') }), shared)).toBe('Amount exact; same date; reference matched.')
    expect(evidenceText(item({ bank: view('A') }), shared)).toBe('Amount exact; same date; reference absent in books.')
    expect(evidenceText(item({}), shared)).toBe('Amount exact; same date; reference absent on both sides.')
  })

  it('names competition instead of hiding it', () => {
    expect(competitionText(item({}))).toBe('Only candidate for both transactions')
    expect(competitionText(item({ unique: false, groupBank: 1, groupBooks: 3, groupPairs: 3 }))).toBe(
      '1 bank transaction and 3 books transactions compete through 3 pairs; no unique pairing',
    )
  })
})
