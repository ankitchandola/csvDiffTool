import { describe, expect, it } from 'vitest'
import { dayNumber, isoDate } from './dates'
import { findCandidates } from './match'
import { DEFAULT_MATCHING, type MatchingRules, type ReconSide, type Transaction } from './types'

type Spec = [day: number, units: number, reference?: string]

function txns(side: ReconSide, specs: Spec[]): Transaction[] {
  return specs.map(([day, units, reference], index) => ({
    side,
    index,
    day: dayNumber(2026, 9, day),
    amount: { units: BigInt(units), scale: 2 },
    reference: reference ?? null,
  }))
}

function pairs(bank: Spec[], books: Spec[], rules: Partial<MatchingRules> = {}) {
  const b = txns('bank', bank)
  const l = txns('books', books)
  const outcome = findCandidates(b, l, { ...DEFAULT_MATCHING, ...rules })
  return outcome.candidates.map((c) => [b[c.bank].index, l[c.books].index, c.tier, c.gap])
}

describe('findCandidates', () => {
  it('pairs exact amounts inside the inclusive window on both sides', () => {
    expect(pairs([[10, 500]], [[7, 500], [13, 500], [6, 500], [14, 500]])).toEqual([
      [0, 0, 3, 3],
      [0, 1, 3, -3],
    ])
  })

  it('applies separate before and after bounds', () => {
    const books: Spec[] = [[1, 500], [11, 500], [12, 500]]
    expect(pairs([[10, 500]], books, { bankDaysAfter: 9, bankDaysBefore: 1 })).toEqual([
      [0, 1, 3, -1],
      [0, 0, 3, 9],
    ])
  })

  it('never pairs money in with money out of the same size', () => {
    expect(pairs([[10, 500]], [[10, -500]])).toEqual([])
  })

  it('never pairs amounts that differ, even by one unit', () => {
    expect(pairs([[10, 500]], [[10, 501]])).toEqual([])
  })

  it('ignores references unless both columns hold the same identifier', () => {
    expect(pairs([[10, 500, 'CHQ1']], [[10, 500, 'INV9']])).toEqual([[0, 0, 3, 0]])
  })

  it('uses shared references as tier 1 evidence and drops conflicting ones', () => {
    const b = txns('bank', [[10, 500, 'CHQ1'], [10, 700, 'chq2'], [10, 900]])
    const l = txns('books', [[10, 500, 'CHQ1'], [11, 700, 'CHQ2'], [10, 900, 'CHQ3'], [10, 500, 'CHQ4']])
    const outcome = findCandidates(b, l, { ...DEFAULT_MATCHING, referencesShared: true })
    expect(outcome.candidates.map((c) => [c.bank, c.books, c.tier])).toEqual([
      [0, 0, 1],
      [2, 2, 3],
    ])
    expect(outcome.referenceConflicts).toBe(2)
    const folded = findCandidates(b, l, { ...DEFAULT_MATCHING, referencesShared: true, referenceCaseInsensitive: true })
    expect(folded.candidates.map((c) => [c.bank, c.books, c.tier])).toContainEqual([1, 1, 1])
  })

  it('finds competition across both sides, not just within one row', () => {
    const b = txns('bank', [[10, 500], [11, 500], [25, 800]])
    const l = txns('books', [[9, 500], [25, 800]])
    const outcome = findCandidates(b, l, { ...DEFAULT_MATCHING, bankDaysBefore: 0 })
    expect(outcome.groups).toEqual([
      { id: 0, bank: [0, 1], books: [0], pairs: 2, unique: false },
      { id: 1, bank: [2], books: [1], pairs: 1, unique: true },
    ])
  })

  it('links a chain of alternatives into one group', () => {
    const b = txns('bank', [[1, 500], [5, 500]])
    const l = txns('books', [[3, 500], [7, 500]])
    const outcome = findCandidates(b, l, { ...DEFAULT_MATCHING, bankDaysBefore: 3, bankDaysAfter: 3 })
    expect(outcome.candidates).toHaveLength(3)
    expect(outcome.groups).toHaveLength(1)
    expect(outcome.groups[0].unique).toBe(false)
  })

  it('lists transactions with no candidate on each side', () => {
    const outcome = findCandidates(txns('bank', [[1, 500], [1, 100]]), txns('books', [[1, 500], [1, 200]]), DEFAULT_MATCHING)
    expect(outcome.noCandidate).toEqual({ bank: [1], books: [1] })
  })

  it('reports an exhausted budget as incomplete, not as no match', () => {
    const many: Spec[] = Array.from({ length: 5 }, () => [10, 500])
    const outcome = findCandidates(txns('bank', many), txns('books', many), DEFAULT_MATCHING, 7)
    expect(outcome.candidates).toHaveLength(7)
    expect(outcome.incomplete).toMatch(/stopped after 7 candidate pairs/)
  })

  it('produces the same suggestions whatever the input order', () => {
    const bank: Spec[] = [[1, 500, 'A'], [2, 500], [2, 500], [9, -120, 'B'], [15, 999], [20, 500], [21, 4200]]
    const books: Spec[] = [[2, 500], [1, 500, 'A'], [10, -120, 'B'], [12, -120], [20, 500], [22, 4200], [30, 5]]
    const rules = { ...DEFAULT_MATCHING, referencesShared: true }
    const describe = (bankSpecs: Spec[], booksSpecs: Spec[]) => {
      const b = txns('bank', bankSpecs)
      const l = txns('books', booksSpecs)
      const outcome = findCandidates(b, l, rules)
      const text = (t: Transaction) => `${isoDate(t.day)}|${t.amount.units}|${t.reference ?? ''}`
      return {
        pairs: outcome.candidates.map((c) => `${text(b[c.bank])}~${text(l[c.books])}~${c.tier}~${c.gap}`).sort(),
        groups: outcome.groups.map((g) => `${g.bank.map((i) => text(b[i])).sort()}/${g.books.map((i) => text(l[i])).sort()}/${g.pairs}`).sort(),
        alone: [outcome.noCandidate.bank.map((i) => text(b[i])).sort(), outcome.noCandidate.books.map((i) => text(l[i])).sort()],
      }
    }
    const expected = describe(bank, books)
    let seed = 7
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let run = 0; run < 20; run++) {
      const shuffle = (list: Spec[]) => list.map((v) => [random(), v] as const).sort((x, y) => x[0] - y[0]).map(([, v]) => v)
      expect(describe(shuffle(bank), shuffle(books))).toEqual(expected)
    }
  })
})
