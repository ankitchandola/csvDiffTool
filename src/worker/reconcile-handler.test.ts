import { describe, expect, it } from 'vitest'
import { DEFAULT_MATCHING, type SessionContext, type SideMapping } from '../reconciliation/types'
import { createReconcileHandler } from './reconcile-handler'
import type { ReconRequests } from './reconcile-protocol'

const CONTEXT: SessionContext = { account: 'Current account', currency: 'INR', minorUnits: 2 }

const BANK = [
  'Account,1234',
  'Period,Sep 2026',
  'Date,Details,Credit,Debit,Ref',
  '01/09/2026,Salary,"50,000.00",,',
  '02/09/2026,Rent,,"12,000.00",CHQ-101',
  '02/09/2026,Subscription,,9.99,',
  '03/09/2026,Bad row,,abc,',
  '04/09/2026,Fee,,0.00,',
  'Closing balance,,,,',
].join('\n')

const BOOKS = ['date,memo,amount,ref', '2026-08-31,Salary in,50000,', '2026-09-02,Rent cheque,-12000,CHQ-101', '2026-09-03,Sub,-9.99,', '2026-09-03,Sub dup,-9.99,'].join('\n')

const bankMapping: SideMapping = {
  delimiter: ',',
  layout: { headerRecord: 3, skipTrailing: 1 },
  date: { column: 'Date', format: 'DD/MM/YYYY', kind: 'posting' },
  amount: { kind: 'split', inColumn: 'Credit', outColumn: 'Debit', unused: 'blank' },
  amountFormat: { grouped: true, trailingMinus: false, parentheses: false },
  reference: 'Ref',
  description: 'Details',
}

const booksMapping: SideMapping = {
  delimiter: ',',
  layout: { headerRecord: 1, skipTrailing: 0 },
  date: { column: 'date', format: 'YYYY-MM-DD', kind: 'posting' },
  amount: { kind: 'signed', column: 'amount', positiveIs: 'in' },
  amountFormat: { grouped: false, trailingMinus: false, parentheses: false },
  reference: 'ref',
  description: 'memo',
}

async function loaded() {
  const handle = createReconcileHandler()
  let id = 1
  const call = <K extends keyof ReconRequests>(type: K, payload: ReconRequests[K]) => handle({ id: id++, type, ...payload } as never) as Promise<never>
  const bank = await call('parse', { side: 'bank', file: new File([BANK], 'bank.csv'), delimiter: 'auto', layout: bankMapping.layout })
  const books = await call('parse', { side: 'books', file: new File([BOOKS], 'books.csv'), delimiter: 'auto', layout: booksMapping.layout })
  return { call, bank, books }
}

describe('reconcile handler', () => {
  it('reads each source with its own layout and fingerprints its bytes', async () => {
    const { bank, books } = await loaded()
    expect(bank).toMatchObject({
      ok: true,
      info: { headers: ['Date', 'Details', 'Credit', 'Debit', 'Ref'], recordCount: 5, skipped: { before: { total: 2 }, after: { items: ['Closing balance,,,,'] } } },
    })
    expect((bank as { info: { fingerprint: string } }).info.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect((books as { info: { recordCount: number } }).info.recordCount).toBe(4)
  })

  it('blocks a mapping that names a missing column, per side', async () => {
    const { call } = await loaded()
    const result = await call('normalize', { context: CONTEXT, mappings: { bank: bankMapping, books: { ...booksMapping, reference: 'Reference' } } })
    expect(result).toEqual({ ok: false, issues: [{ side: 'books', message: 'Column "Reference" is not in this file' }] })
  })

  it('summarizes normalization with original and normalized samples', async () => {
    const { call } = await loaded()
    const result: { ok: true; sides: Record<'bank' | 'books', { valid: number; zero: number; problemRows: number; moneyIn: number; sample: unknown[] }> } = await call('normalize', {
      context: CONTEXT,
      mappings: { bank: bankMapping, books: booksMapping },
    })
    expect(result.sides.bank).toMatchObject({ rows: 5, valid: 3, moneyIn: 1, moneyOut: 2, zero: 1, problemRows: 1 })
    expect(result.sides.bank.sample[1]).toEqual({
      side: 'bank',
      recordNumber: 2,
      span: { first: 5, last: 5 },
      original: { date: '02/09/2026', amount: ['', '12,000.00'], reference: 'CHQ-101', description: 'Rent' },
      normalized: { date: '2026-09-02', amount: '-12000.00', direction: 'out' },
      zero: false,
      problems: [],
    })
    expect(result.sides.bank.sample[3]).toMatchObject({ normalized: null, problems: ['Money out: "abc" is not a number in the chosen format'] })
  })

  it('suggests pairs, shows competition, and pages every tab from the worker', async () => {
    const { call } = await loaded()
    const { revision } = await call('normalize', { context: CONTEXT, mappings: { bank: bankMapping, books: booksMapping } })
    const summary = await call('match', { revision, rules: { ...DEFAULT_MATCHING, referencesShared: true } })
    expect(summary).toMatchObject({
      pairs: 4,
      groups: 3,
      uniqueGroups: 2,
      withCandidates: { bank: 3, books: 4 },
      noCandidate: { bank: 0, books: 0 },
      invalid: { bank: 1, books: 0 },
      zero: { bank: 1, books: 0 },
      incomplete: null,
    })
    const { matchId } = summary as { matchId: number }
    const suggested: { total: number; items: { tier: number; unique: boolean; groupBooks: number; bank: { original: { description: string } } }[] } = await call('getReview', { matchId, tab: 'suggested', offset: 0, limit: 10 })
    expect(suggested.items.map((i) => [i.bank.original.description, i.tier, i.unique, i.groupBooks])).toEqual([
      ['Salary', 3, true, 1],
      ['Rent', 1, true, 1],
      ['Subscription', 3, false, 2],
      ['Subscription', 3, false, 2],
    ])
    const searched: { total: number } = await call('getReview', { matchId, tab: 'suggested', offset: 0, limit: 10, search: 'chq-101' })
    expect(searched.total).toBe(1)
    const incoming: { total: number } = await call('getReview', { matchId, tab: 'suggested', offset: 0, limit: 10, direction: 'in' })
    expect(incoming.total).toBe(1)
    const problems: { items: { kind: string; recordNumber: number }[] } = await call('getReview', { matchId, tab: 'problems', offset: 0, limit: 10 })
    expect(problems.items.map((p) => [p.kind, p.recordNumber])).toEqual([
      ['invalid', 4],
      ['zero', 5],
    ])
  })

  it('rejects stale suggestions and matches after a source is replaced', async () => {
    const { call } = await loaded()
    const { revision } = await call('normalize', { context: CONTEXT, mappings: { bank: bankMapping, books: booksMapping } })
    const { matchId } = await call('match', { revision, rules: DEFAULT_MATCHING })
    await call('parse', { side: 'books', file: new File([BOOKS], 'books.csv'), delimiter: 'auto', layout: booksMapping.layout })
    await expect(call('getReview', { matchId, tab: 'suggested', offset: 0, limit: 10 })).rejects.toThrow()
    await expect(call('match', { revision, rules: DEFAULT_MATCHING })).rejects.toThrow('changed')
  })
})
