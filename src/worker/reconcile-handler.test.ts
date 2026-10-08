import * as XLSX from 'xlsx'
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
  balance: null,
}

const booksMapping: SideMapping = {
  delimiter: ',',
  layout: { headerRecord: 1, skipTrailing: 0 },
  date: { column: 'date', format: 'YYYY-MM-DD', kind: 'posting' },
  amount: { kind: 'signed', column: 'amount', positiveIs: 'in' },
  amountFormat: { grouped: false, trailingMinus: false, parentheses: false },
  reference: 'ref',
  description: 'memo',
  balance: null,
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
    const result = await call('normalize', { context: CONTEXT, mappings: { bank: bankMapping, books: { ...booksMapping, reference: 'Reference' } }, period: null })
    expect(result).toEqual({ ok: false, issues: [{ side: 'books', message: 'Column "Reference" is not in this file' }] })
  })

  it('summarizes normalization with original and normalized samples', async () => {
    const { call } = await loaded()
    const result: { ok: true; sides: Record<'bank' | 'books', { valid: number; zero: number; problemRows: number; moneyIn: number; sample: unknown[] }> } = await call('normalize', {
      context: CONTEXT,
      mappings: { bank: bankMapping, books: booksMapping },
      period: null,
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
    const { revision } = await call('normalize', { context: CONTEXT, mappings: { bank: bankMapping, books: booksMapping }, period: null })
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
    const spanning: { total: number } = await call('getReview', { matchId, tab: 'suggested', offset: 0, limit: 10, search: '2026-09-0150000' })
    expect(spanning.total).toBe(0)
    const unmatchedIn: { total: number } = await call('getReview', { matchId, tab: 'unmatched', offset: 0, limit: 10, direction: 'in' })
    expect(unmatchedIn.total).toBe(2)
    const problems: { items: { kind: string; recordNumber: number }[] } = await call('getReview', { matchId, tab: 'problems', offset: 0, limit: 10 })
    expect(problems.items.map((p) => [p.kind, p.recordNumber])).toEqual([
      ['invalid', 4],
      ['zero', 5],
    ])
  })

  it('rejects stale suggestions and matches after a source is replaced', async () => {
    const { call } = await loaded()
    const { revision } = await call('normalize', { context: CONTEXT, mappings: { bank: bankMapping, books: booksMapping }, period: null })
    const { matchId } = await call('match', { revision, rules: DEFAULT_MATCHING })
    await call('parse', { side: 'books', file: new File([BOOKS], 'books.csv'), delimiter: 'auto', layout: booksMapping.layout })
    await expect(call('getReview', { matchId, tab: 'suggested', offset: 0, limit: 10 })).rejects.toThrow()
    await expect(call('match', { revision, rules: DEFAULT_MATCHING })).rejects.toThrow('changed')
  })
})

describe('reconcile handler decisions', () => {
  type Item = { tier: number; bank: { key: string; original: { description: string } }; books: { key: string; original: { description: string } } }

  async function suggested() {
    const loaded_ = await loaded()
    const { call } = loaded_
    const { revision } = await call('normalize', { context: CONTEXT, mappings: { bank: bankMapping, books: booksMapping }, period: null })
    const { matchId } = await call('match', { revision, rules: { ...DEFAULT_MATCHING, referencesShared: true } })
    await call('setDecisions', { matchId, events: [] })
    const page: { items: Item[] } = await call('getReview', { matchId, tab: 'suggested', offset: 0, limit: 10 })
    const find = (bank: string, books: string) => page.items.find((i) => i.bank.original.description === bank && i.books.original.description === books) as Item
    return { ...loaded_, revision, matchId, find }
  }

  const AT = '2026-10-07T10:00:00.000Z'

  it('confirms a suggestion, consumes both sides and removes competing pairs', async () => {
    const { call, matchId, find } = await suggested()
    const sub = find('Subscription', 'Sub')
    const result: { ok: true; summary: { suggested: number; confirmed: number; unmatched: { bank: number; books: number } }; snapshots: { amount: string }[] } = await call('decide', {
      matchId,
      seq: 1,
      at: AT,
      decision: { action: 'confirm', bank: sub.bank.key, books: sub.books.key, origin: 'suggested' },
    })
    expect(result.ok).toBe(true)
    expect(result.summary).toMatchObject({ suggested: 2, confirmed: 1, unmatched: { bank: 2, books: 3 } })
    expect(result.snapshots.map((s) => s.amount)).toEqual(['-9.99', '-9.99'])
    const confirmed: { total: number; items: { tier: number; event: { seq: number } }[] } = await call('getReview', { matchId, tab: 'confirmed', offset: 0, limit: 10 })
    expect(confirmed.items).toMatchObject([{ tier: 3, event: { seq: 1 } }])
    const unmatched: { items: { original: { description: string }; suggestions: number }[] } = await call('getReview', { matchId, tab: 'unmatched', offset: 0, limit: 10 })
    expect(unmatched.items.find((u) => u.original.description === 'Sub dup')?.suggestions).toBe(0)
  })

  it('refuses decisions out of order or that break the history', async () => {
    const { call, matchId, find } = await suggested()
    const salary = find('Salary', 'Salary in')
    await expect(call('decide', { matchId, seq: 2, at: AT, decision: { action: 'reject', bank: salary.bank.key, books: salary.books.key } })).rejects.toThrow('out of step')
    expect(await call('decide', { matchId, seq: 1, at: AT, decision: { action: 'unmatch', bank: salary.bank.key, books: salary.books.key } })).toEqual({ ok: false, reason: 'This pair is not confirmed' })
  })

  it('keeps a rejected pair out of suggestions and lists it for restoring', async () => {
    const { call, matchId, find } = await suggested()
    const sub = find('Subscription', 'Sub dup')
    const result: { summary: { suggested: number; rejected: number } } = await call('decide', { matchId, seq: 1, at: AT, decision: { action: 'reject', bank: sub.bank.key, books: sub.books.key } })
    expect(result.summary).toMatchObject({ suggested: 3, rejected: 1 })
    const rejected: { items: { bank: { original: { description: string } } }[] } = await call('getReview', { matchId, tab: 'rejected', offset: 0, limit: 10 })
    expect(rejected.items.map((r) => r.bank.original.description)).toEqual(['Subscription'])
  })

  it('requires a reason for a manual pair that breaks rules and blocks opposite directions', async () => {
    const { call, matchId, find } = await suggested()
    const salary = find('Salary', 'Salary in')
    const rent = find('Rent', 'Rent cheque')
    const check: { blocked: string | null; exceptions: string[] } = await call('checkPair', { matchId, bank: salary.bank.key, books: rent.books.key })
    expect(check).toMatchObject({ blocked: 'Money in cannot pair with money out', exceptions: [] })
    const sub = find('Subscription', 'Sub')
    const rentToSub: { blocked: string | null; exceptions: string[] } = await call('checkPair', { matchId, bank: rent.bank.key, books: sub.books.key })
    expect(rentToSub).toMatchObject({ blocked: null, exceptions: ['amount'] })
    const bare = { action: 'confirm' as const, bank: rent.bank.key, books: sub.books.key, origin: 'manual' as const }
    expect(await call('decide', { matchId, seq: 1, at: AT, decision: bare })).toMatchObject({ ok: false })
    expect(await call('decide', { matchId, seq: 1, at: AT, decision: { ...bare, exceptions: ['amount'], reason: 'Partial payment' } })).toMatchObject({ ok: true })
  })

  it('replays the history after a rerun and lapses decisions about a replaced file', async () => {
    const { call, matchId, find } = await suggested()
    const salary = find('Salary', 'Salary in')
    const confirm = { seq: 1, at: AT, action: 'confirm' as const, bank: salary.bank.key, books: salary.books.key, origin: 'suggested' as const }
    await call('setDecisions', { matchId, events: [confirm] })
    const { revision } = await call('normalize', { context: CONTEXT, mappings: { bank: bankMapping, books: booksMapping }, period: null })
    const rerun = await call('match', { revision, rules: DEFAULT_MATCHING })
    expect(await call('setDecisions', { matchId: (rerun as { matchId: number }).matchId, events: [confirm] })).toMatchObject({ confirmed: 1, lapsed: [] })
    await call('parse', { side: 'books', file: new File([BOOKS + '\n2026-09-30,Extra,1,'], 'books.csv'), delimiter: 'auto', layout: booksMapping.layout })
    const again = await call('normalize', { context: CONTEXT, mappings: { bank: bankMapping, books: booksMapping }, period: null })
    const third = await call('match', { revision: (again as { revision: number }).revision, rules: DEFAULT_MATCHING })
    expect(await call('setDecisions', { matchId: (third as { matchId: number }).matchId, events: [confirm] })).toMatchObject({
      confirmed: 0,
      lapsed: [{ reason: 'Its source file was replaced or is not loaded' }],
    })
  })
})

describe('reconcile handler sets and inspection', () => {
  const SET_BANK = ['date,amount,memo', '2026-09-05,-9.99,NETFLIX', '2026-09-05,-9.99,NETFLIX', '2026-09-05,-9.99,NETFLIX', '2026-09-06,-50.00,Rent'].join('\n')
  const SET_BOOKS = ['date,amount,memo', '2026-09-05,-9.99,Netflix', '2026-09-05,-9.99,Netflix', '2026-09-06,-50.00,Rent', '2026-09-06,-50.00,Other rent'].join('\n')
  const mapping: SideMapping = {
    delimiter: ',',
    layout: { headerRecord: 1, skipTrailing: 0 },
    date: { column: 'date', format: 'YYYY-MM-DD', kind: 'posting' },
    amount: { kind: 'signed', column: 'amount', positiveIs: 'in' },
    amountFormat: { grouped: false, trailingMinus: false, parentheses: false },
    reference: null,
    description: 'memo',
    balance: null,
  }

  async function run() {
    const handle = createReconcileHandler()
    let id = 1
    const call = <K extends keyof ReconRequests>(type: K, payload: ReconRequests[K]) => handle({ id: id++, type, ...payload } as never) as Promise<never>
    await call('parse', { side: 'bank', file: new File([SET_BANK], 'bank.csv'), delimiter: ',', layout: mapping.layout })
    await call('parse', { side: 'books', file: new File([SET_BOOKS], 'books.csv'), delimiter: ',', layout: mapping.layout })
    const { revision } = await call('normalize', { context: CONTEXT, mappings: { bank: mapping, books: mapping }, period: null })
    const { matchId } = await call('match', { revision, rules: DEFAULT_MATCHING })
    await call('setDecisions', { matchId, events: [] })
    const page: { items: { group: number; set: string | null; bank: { original: { description: string } } }[] } = await call('getReview', { matchId, tab: 'suggested', offset: 0, limit: 50 })
    return { call, matchId, page }
  }

  it('marks identical repeated transactions as an interchangeable set, and different descriptions as not', async () => {
    const { page } = await run()
    const kinds = new Map(page.items.map((i) => [i.bank.original.description, i.set]))
    expect(kinds.get('NETFLIX')).toBe('interchangeable')
    expect(kinds.get('Rent')).toBe('different-descriptions')
  })

  it('confirms a set whole, and refuses one with differing descriptions', async () => {
    const { call, matchId, page } = await run()
    const netflix = page.items.find((i) => i.bank.original.description === 'NETFLIX') as { group: number }
    const set: { bank: { key: string; recordNumber: number }[]; books: { key: string }[]; blocked: string | null } = await call('getSet', { matchId, group: netflix.group })
    expect(set.bank.map((v) => v.recordNumber)).toEqual([1, 2, 3])
    expect(set.books).toHaveLength(2)
    expect(set.blocked).toBeNull()
    const pairs = [0, 1].map((i) => ({ bank: set.bank[i].key, books: set.books[i].key }))
    await expect(call('decideSet', { matchId, group: netflix.group, seq: 1, at: '2026-10-08T00:00:00Z', pairs })).resolves.toMatchObject({
      ok: true,
      events: [{ seq: 1, origin: 'set' }, { seq: 2, origin: 'set' }],
      summary: { confirmed: 2 },
    })
    const after: { bank: unknown[]; blocked: string | null } = await call('getSet', { matchId, group: netflix.group })
    expect(after).toMatchObject({ blocked: 'Nothing in this set is left to confirm' })
    expect(after.bank).toHaveLength(1)

    const rent = page.items.find((i) => i.bank.original.description === 'Rent') as { group: number }
    const rentSet: { blocked: string | null } = await call('getSet', { matchId, group: rent.group })
    expect(rentSet.blocked).toMatch(/descriptions differ/)
  })

  it('records nothing when any pair in a set is invalid', async () => {
    const { call, matchId, page } = await run()
    const netflix = page.items.find((i) => i.bank.original.description === 'NETFLIX') as { group: number }
    const set: { bank: { key: string }[]; books: { key: string }[] } = await call('getSet', { matchId, group: netflix.group })
    const reused = [
      { bank: set.bank[0].key, books: set.books[0].key },
      { bank: set.bank[1].key, books: set.books[0].key },
    ]
    expect(await call('decideSet', { matchId, group: netflix.group, seq: 1, at: '2026-10-08T00:00:00Z', pairs: reused })).toMatchObject({ ok: false })
    expect(await call('setDecisions', { matchId, events: [] })).toMatchObject({ confirmed: 0 })
  })

  it('inspects a transaction with its full source row, match and alternatives', async () => {
    const { call, matchId, page } = await run()
    const netflix = page.items.find((i) => i.bank.original.description === 'NETFLIX') as unknown as { bank: { key: string }; books: { key: string } }
    const [detail, missing]: ({ headers: string[]; values: string[]; alternativesTotal: number; match: unknown } | null)[] = await call('inspect', { matchId, keys: [netflix.bank.key, 'bank|' + 'f'.repeat(64) + '|1'] })
    expect(detail).toMatchObject({ headers: ['date', 'amount', 'memo'], values: ['2026-09-05', '-9.99', 'NETFLIX'], alternativesTotal: 2, match: null })
    expect(missing).toBeNull()
    await call('decide', { matchId, seq: 1, at: '2026-10-08T00:00:00Z', decision: { action: 'confirm', bank: netflix.bank.key, books: netflix.books.key, origin: 'suggested' } })
    const [confirmed]: { match: { event: { seq: number } } | null; alternativesTotal: number }[] = await call('inspect', { matchId, keys: [netflix.bank.key] })
    expect(confirmed).toMatchObject({ match: { event: { seq: 1 } }, alternativesTotal: 0 })
  })
})

describe('reconcile handler classification and completion', () => {
  const BANK_SET = ['date,amount,memo', '2026-09-05,-9.99,NETFLIX', '2026-09-05,-9.99,NETFLIX', '2026-09-05,-9.99,NETFLIX', '2026-09-06,-50.00,Rent'].join('\n')
  const BOOKS_SET = ['date,amount,memo', '2026-09-05,-9.99,Netflix', '2026-09-05,-9.99,Netflix', '2026-09-06,-50.00,Rent', '2026-09-06,-50.00,Other rent'].join('\n')
  const mapping: SideMapping = {
    delimiter: ',',
    layout: { headerRecord: 1, skipTrailing: 0 },
    date: { column: 'date', format: 'YYYY-MM-DD', kind: 'posting' },
    amount: { kind: 'signed', column: 'amount', positiveIs: 'in' },
    amountFormat: { grouped: false, trailingMinus: false, parentheses: false },
    reference: null,
    description: 'memo',
    balance: null,
  }
  const setup = {
    period: { start: '2026-09-01', end: '2026-09-30' },
    balances: { bank: { opening: '1000.00', closing: '920.03', basis: 'cash' as const }, books: { opening: '1000.00', closing: '880.02', basis: 'cash' as const } },
  }
  const AT = '2026-10-08T00:00:00Z'

  async function reviewed() {
    const handle = createReconcileHandler()
    let id = 1
    const call = <K extends keyof ReconRequests>(type: K, payload: ReconRequests[K]) => handle({ id: id++, type, ...payload } as never) as Promise<never>
    await call('parse', { side: 'bank', file: new File([BANK_SET], 'bank.csv'), delimiter: ',', layout: mapping.layout })
    await call('parse', { side: 'books', file: new File([BOOKS_SET], 'books.csv'), delimiter: ',', layout: mapping.layout })
    const { revision } = await call('normalize', { context: CONTEXT, mappings: { bank: mapping, books: mapping }, period: null })
    const { matchId } = await call('match', { revision, rules: DEFAULT_MATCHING })
    await call('setDecisions', { matchId, events: [] })
    const page: { items: { group: number; bank: { key: string; original: { description: string } }; books: { key: string; original: { description: string } } }[] } = await call('getReview', { matchId, tab: 'suggested', offset: 0, limit: 50 })
    let seq = 0
    // The sequence advances only when the worker records the decision.
    const decide = async (decision: object) => {
      const result = (await call('decide', { matchId, seq: seq + 1, at: AT, decision } as never)) as { ok: boolean; reason?: string }
      if (result.ok) seq++
      return result
    }
    const status = () => call('accounting', { matchId, setup, basis: 'b1' }) as Promise<{ statuses: { [k: string]: { earned: boolean; reasons: string[] }; canMarkComplete: never }; facts: { unclassified: number } }>
    const mark = async (basis = 'b1') => {
      const result = (await call('markComplete', { matchId, seq: seq + 1, at: AT, setup, basis })) as { ok: boolean; reason?: string }
      if (result.ok) seq++
      return result
    }
    const pair = (bank: string, books: string, nth = 0) => page.items.filter((i) => i.bank.original.description === bank && i.books.original.description === books)[nth]
    return { call, matchId, page, decide, status, mark, pair, seq: () => seq }
  }

  it('validates the sources from typed balances, and needs every unmatched item classified', async () => {
    const r = await reviewed()
    const before = await r.status()
    expect(before.statuses.sourcesValidated.earned).toBe(true)
    expect(before.statuses.bridgeComplete.earned).toBe(true)
    expect(before.facts.unclassified).toBe(8)
    expect(before.statuses.completed.earned).toBe(false)
    expect(await r.mark()).toMatchObject({ ok: false, reason: expect.stringContaining('8 unmatched items are not classified') })
  })

  it('classifies with fitting choices only, and completes once everything is reviewed', async () => {
    const r = await reviewed()
    const netflix = r.pair('NETFLIX', 'Netflix')
    const rent = r.pair('Rent', 'Rent')
    for (const [bank, books] of [[netflix.bank.key, netflix.books.key], [rent.bank.key, rent.books.key]]) {
      await r.decide({ action: 'confirm', bank, books, origin: 'suggested' })
    }
    const second = (await r.call('getSet', { matchId: r.matchId, group: netflix.group })) as { bank: { key: string }[]; books: { key: string }[] }
    await r.decide({ action: 'confirm', bank: second.bank[0].key, books: second.books[0].key, origin: 'suggested' })
    const unmatched: { items: { key: string; side: string; original: { description: string } }[] } = await r.call('getReview', { matchId: r.matchId, tab: 'unmatched', offset: 0, limit: 10 })
    expect(unmatched.items.map((u) => u.original.description)).toEqual(['NETFLIX', 'Other rent'])
    const [bankLeft, booksLeft] = unmatched.items
    expect(await r.decide({ action: 'classify', key: bankLeft.key, classification: 'deposit-in-transit' })).toMatchObject({ ok: false, reason: expect.stringContaining('does not fit') })
    await r.decide({ action: 'classify', key: bankLeft.key, classification: 'record-in-books', note: 'Duplicate charge' })
    await r.decide({ action: 'classify', key: booksLeft.key, classification: 'outstanding-payment' })
    expect((await r.status()).statuses.canMarkComplete).toBe(true)
    expect(await r.mark()).toMatchObject({ ok: true })
    expect((await r.status()).statuses.completed).toEqual({ earned: true, reasons: [] })

    // A changed setup or any later decision withdraws completion.
    const changed = (await r.call('accounting', { matchId: r.matchId, setup, basis: 'b2' })) as { statuses: { completed: { reasons: string[] } } }
    expect(changed.statuses.completed.reasons).toEqual(['Marked complete earlier, but decisions or the setup changed since'])
    await r.decide({ action: 'classify', key: booksLeft.key, classification: 'investigate' })
    expect((await r.status()).statuses.completed.earned).toBe(false)
  })

  it('refuses to classify a transaction in a confirmed match', async () => {
    const r = await reviewed()
    const rent = r.pair('Rent', 'Rent')
    await r.decide({ action: 'confirm', bank: rent.bank.key, books: rent.books.key, origin: 'suggested' })
    expect(await r.decide({ action: 'classify', key: rent.bank.key, classification: 'record-in-books' })).toMatchObject({ ok: false, reason: 'A transaction in a confirmed match is not classified' })
  })

  it('reports balance text it cannot read and does not validate that side', async () => {
    const r = await reviewed()
    const bad = (await r.call('accounting', {
      matchId: r.matchId,
      setup: { ...setup, balances: { ...setup.balances, bank: { ...setup.balances.bank, closing: '920.031' } } },
      basis: 'b1',
    })) as { balanceErrors: string[]; statuses: { sourcesValidated: { earned: boolean } } }
    expect(bad.balanceErrors).toEqual(['Bank closing balance "920.031" is not an amount with at most 2 decimal places'])
    expect(bad.statuses.sourcesValidated.earned).toBe(false)
  })
})

describe('reconcile handler carry-forward', () => {
  const mapping = (format: 'DD/MM/YYYY' | 'YYYY-MM-DD'): SideMapping => ({
    delimiter: ',',
    layout: { headerRecord: 1, skipTrailing: 0 },
    date: { column: 'date', format, kind: 'posting' },
    amount: { kind: 'signed', column: 'amount', positiveIs: 'in' },
    amountFormat: { grouped: false, trailingMinus: false, parentheses: false },
    reference: 'ref',
    description: 'memo',
    balance: null,
  })
  const SEP = { start: '2026-09-01', end: '2026-09-30' }
  const OCT = { start: '2026-10-01', end: '2026-10-31' }
  const RULES = { ...DEFAULT_MATCHING, referencesShared: true, bankDaysAfter: 40 }
  const AT = '2026-10-08T00:00:00Z'

  async function session(bank: string, books: string, period: { start: string; end: string }, openingText?: string) {
    const handle = createReconcileHandler()
    let id = 1
    const call = <K extends keyof ReconRequests>(type: K, payload: ReconRequests[K]) => handle({ id: id++, type, ...payload } as never) as Promise<never>
    await call('parse', { side: 'bank', file: new File([bank], 'bank.csv'), delimiter: ',', layout: { headerRecord: 1, skipTrailing: 0 } })
    await call('parse', { side: 'books', file: new File([books], 'books.csv'), delimiter: ',', layout: { headerRecord: 1, skipTrailing: 0 } })
    if (openingText) expect(await call('setOpening', { files: [{ name: 'outstanding-sep.json', text: openingText }] })).toMatchObject({ ok: true })
    const normalized: { ok: boolean; revision: number; opening?: { items: object; overlaps: unknown[] }; issues?: unknown[] } = await call('normalize', {
      context: CONTEXT,
      mappings: { bank: mapping('DD/MM/YYYY'), books: mapping('YYYY-MM-DD') },
      period,
    })
    const none = { decide: async () => ({ ok: false }), suggestions: async () => [], unmatched: async () => [], nextSeq: () => 1 }
    if (!normalized.ok) return { call, normalized, matchId: 0, ...none }
    const { matchId } = await call('match', { revision: normalized.revision, rules: RULES })
    await call('setDecisions', { matchId, events: [] })
    let seq = 0
    const decide = async (decision: object) => {
      const result = (await call('decide', { matchId, seq: seq + 1, at: AT, decision } as never)) as { ok: boolean; reason?: string }
      if (result.ok) seq++
      return result
    }
    const suggestions = async () =>
      ((await call('getReview', { matchId, tab: 'suggested', offset: 0, limit: 50 })) as { items: { bank: { key: string; original: { description: string } }; books: { key: string; carried?: unknown; original: { description: string } } }[] }).items
    const unmatched = async () => ((await call('getReview', { matchId, tab: 'unmatched', offset: 0, limit: 50 })) as { items: { key: string; side: string; carried?: unknown; original: { description: string } }[] }).items
    return { call, normalized, matchId, decide, suggestions, unmatched, nextSeq: () => seq + 1 }
  }

  const BANK_SEP = 'date,amount,ref,memo\n11/09/2026,300.00,,Receipt\n'
  const BOOKS_SEP = 'date,amount,ref,memo\n2026-09-10,300.00,,Receipt\n2026-09-15,-50.00,CHQ102,Cheque 102 issued\n2026-09-29,-200.00,CHQ101,Cheque 101 issued\n'
  const BANK_OCT = 'date,amount,ref,memo\n02/10/2026,-200.00,CHQ101,Cheque 101 cleared\n20/10/2026,-50.00,CHQ102,Cheque 102 cleared\n31/10/2026,-10.00,,Bank charge\n'
  const BOOKS_OCT = 'date,amount,ref,memo\n2026-10-30,500.00,,Receipt\n'

  async function september() {
    const sep = await session(BANK_SEP, BOOKS_SEP, SEP)
    const [receipt] = await sep.suggestions()
    await sep.decide({ action: 'confirm', bank: receipt.bank.key, books: receipt.books.key, origin: 'suggested' })
    for (const u of await sep.unmatched()) await sep.decide({ action: 'classify', key: u.key, classification: 'outstanding-payment' })
    const exported: { text: string; items: number; cleared: number } = await sep.call('exportOutstanding', { matchId: sep.matchId, sessionId: 'sep', period: SEP, exportedAt: AT })
    return { sep, exported }
  }

  it('exports September’s outstanding cheques with their lineage and provenance', async () => {
    const { exported } = await september()
    expect(exported).toMatchObject({ items: 2, cleared: 0 })
    const file = JSON.parse(exported.text)
    expect(file.items.map((i: { side: string; amount: string; date: string; origin: { fileName: string; recordNumber: number } }) => [i.side, i.amount, i.date, i.origin.fileName, i.origin.recordNumber])).toEqual([
      ['books', '-50.00', '2026-09-15', 'books.csv', 2],
      ['books', '-200.00', '2026-09-29', 'books.csv', 3],
    ])
  })

  it('clears the carried cheques in October without counting them in October’s movement', async () => {
    const { exported } = await september()
    const oct = await session(BANK_OCT, BOOKS_OCT, OCT, exported.text)
    expect(oct.normalized.opening).toEqual({ items: { bank: 0, books: 2 }, warnings: [], overlaps: [] })
    const pairs = await oct.suggestions()
    expect(pairs.map((p) => [p.bank.original.description, p.books.original.description, Boolean(p.books.carried)])).toEqual([
      ['Cheque 101 cleared', 'Cheque 101 issued', true],
      ['Cheque 102 cleared', 'Cheque 102 issued', true],
    ])
    for (const p of pairs) await oct.decide({ action: 'confirm', bank: p.bank.key, books: p.books.key, origin: 'suggested' })
    for (const u of await oct.unmatched()) await oct.decide({ action: 'classify', key: u.key, classification: u.side === 'bank' ? 'record-in-books' : 'deposit-in-transit' })
    const setup = {
      period: OCT,
      balances: { bank: { opening: '1300.00', closing: '1040.00', basis: 'cash' as const }, books: { opening: '1050.00', closing: '1550.00', basis: 'cash' as const } },
    }
    const report: { bridge: { complete: boolean; opening: { status: string } }; movement: { books: { units: bigint } }; statuses: { canMarkComplete: boolean } } = await oct.call('accounting', { matchId: oct.matchId, setup, basis: 'x' })
    expect(report.bridge.opening.status).toBe('pass')
    expect(report.movement.books.units).toBe(50000n)
    expect(report.bridge.complete).toBe(true)
    expect(report.statuses.canMarkComplete).toBe(true)
    const next: { text: string; items: number; cleared: number } = await oct.call('exportOutstanding', { matchId: oct.matchId, sessionId: 'oct', period: OCT, exportedAt: AT })
    expect(next).toMatchObject({ items: 2, cleared: 2 })
    expect(JSON.parse(next.text).cleared.sort()).toEqual(JSON.parse(exported.text).items.map((i: { lineage: string }) => i.lineage).sort())
  })

  it('needs the period to import opening items, and refuses a file from the same period', async () => {
    const { exported } = await september()
    const noPeriod = await session(BANK_OCT, BOOKS_OCT, null as never, exported.text)
    expect(noPeriod.normalized).toMatchObject({ ok: false, issues: [{ message: 'Enter the period before importing opening items' }] })
    const samePeriod = await session(BANK_OCT, BOOKS_OCT, SEP, exported.text)
    expect(samePeriod.normalized.ok).toBe(false)
  })

  it('reports a carried item that the current files repeat, and refuses unreadable files whole', async () => {
    const { exported } = await september()
    const overlapping = await session(BANK_OCT, 'date,amount,ref,memo\n2026-09-29,-200.00,CHQ101,Cheque 101 issued\n' + BOOKS_OCT.split('\n').slice(1).join('\n'), OCT, exported.text)
    expect(overlapping.normalized.opening?.overlaps).toEqual([{ lineage: JSON.parse(exported.text).items[1].lineage, side: 'books', records: [1] }])
    const bad = createReconcileHandler()
    expect(await bad({ id: 1, type: 'setOpening', files: [{ name: 'a.json', text: '{' }, { name: 'b.json', text: '{"format":"other"}' }] })).toEqual({
      ok: false,
      errors: [
        { name: 'a.json', message: 'The file is not valid JSON' },
        { name: 'b.json', message: 'This is not an outstanding-items file' },
      ],
    })
  })

  async function completedOctober() {
    const { exported } = await september()
    const oct = await session(BANK_OCT, BOOKS_OCT, OCT, exported.text)
    for (const p of await oct.suggestions()) await oct.decide({ action: 'confirm', bank: p.bank.key, books: p.books.key, origin: 'suggested' })
    for (const u of await oct.unmatched()) await oct.decide({ action: 'classify', key: u.key, classification: u.side === 'bank' ? 'record-in-books' : 'deposit-in-transit', note: 'checked' })
    const setup = {
      period: OCT,
      balances: { bank: { opening: '1300.00', closing: '1040.00', basis: 'cash' as const }, books: { opening: '1050.00', closing: '1550.00', basis: 'cash' as const } },
    }
    await oct.call('markComplete', { matchId: oct.matchId, seq: oct.nextSeq(), at: AT, setup, basis: 'b' })
    const exportReport = (format: 'json' | 'xlsx') =>
      oct.call('exportReport', { matchId: oct.matchId, format, setup, basis: 'b', session: { id: 'oct', revision: 9 }, generatedAt: AT }) as Promise<Blob>
    return { exportReport }
  }

  it('reports provenance, statuses, matches with evidence, outstanding items and the history', async () => {
    const { exportReport } = await completedOctober()
    const report = JSON.parse(await (await exportReport('json')).text())
    expect(report).toMatchObject({
      format: 'reconciliation-report',
      version: 1,
      experimental: true,
      session: { id: 'oct', revision: 9 },
      currency: 'INR',
      period: OCT,
      sources: { bank: { fileName: 'bank.csv', recordCount: 3 }, books: { fileName: 'books.csv', recordCount: 1 } },
      opening: [{ fileName: 'outstanding-sep.json', items: 2, cleared: 0 }],
      counts: { books: { rows: 1, valid: 1, invalid: 0, zero: 0, opening: 2 } },
      statuses: { completed: { earned: true, reasons: [] } },
      bridge: { closingDifference: '-510.00', explained: '-510.00', unexplained: '0.00', complete: true },
    })
    expect(report.matches.map((m: { variance: string; dateGap: number; tier: number; books: { carried: { lineage: string } | null } }) => [m.variance, m.dateGap, m.tier, Boolean(m.books.carried)])).toEqual([
      ['0.00', 3, 1, true],
      ['0.00', 35, 1, true],
    ])
    expect(report.outstanding.map((o: { transaction: { description: string }; classification: string }) => [o.transaction.description, o.classification])).toEqual([
      ['Bank charge', 'record-in-books'],
      ['Receipt', 'deposit-in-transit'],
    ])
    expect(report.decisions.at(-1)).toMatchObject({ action: 'complete' })
    expect(typeof report.matches[0].bank.amount).toBe('string')
  })

  it('writes the report as a workbook of text cells only, with no formulas', async () => {
    const { exportReport } = await completedOctober()
    const bytes = await (await exportReport('xlsx')).arrayBuffer()
    const book = XLSX.read(bytes, { type: 'array' })
    expect(book.SheetNames).toEqual(['Summary', 'Matches', 'Outstanding', 'Problems', 'Decisions'])
    const summary = XLSX.utils.sheet_to_json<string[]>(book.Sheets.Summary, { header: 1 })
    expect(summary).toContainEqual(['Reconciliation completed', 'Yes'])
    expect(summary).toContainEqual(['Closing difference (bank − books)', '-510.00'])
    const zip = XLSX.CFB.read(new Uint8Array(bytes), { type: 'array' })
    for (const [i, path] of zip.FullPaths.entries()) {
      if (!/xl\/worksheets\/sheet\d+\.xml$/.test(path)) continue
      const xml = new TextDecoder().decode(zip.FileIndex[i].content as Uint8Array)
      expect(xml, path).not.toContain('<f>')
      const types = [...xml.matchAll(/<c r="[A-Z]+\d+"([^>]*)>/g)].map((m) => /t="([^"]+)"/.exec(m[1])?.[1])
      expect(new Set(types), path).toEqual(new Set(['s']))
    }
  })

  it('inspects a carried item with where it first appeared', async () => {
    const { exported } = await september()
    const oct = await session(BANK_OCT, BOOKS_OCT, OCT, exported.text)
    const carried = (await oct.unmatched()).find((u) => u.carried) as { key: string }
    const [detail]: { headers: string[]; values: string[] }[] = await oct.call('inspect', { matchId: oct.matchId, keys: [carried.key] })
    expect(detail.headers[0]).toBe('Lineage')
    expect(detail.values.slice(1, 3)).toEqual(['2026-09-15', '-50.00'])
  })
})

describe('reconcile handler running balance', () => {
  const mapping: SideMapping = {
    delimiter: ',',
    layout: { headerRecord: 1, skipTrailing: 0 },
    date: { column: 'date', format: 'YYYY-MM-DD', kind: 'posting' },
    amount: { kind: 'signed', column: 'amount', positiveIs: 'in' },
    amountFormat: { grouped: true, trailingMinus: false, parentheses: false },
    reference: null,
    description: null,
    balance: 'balance',
  }

  async function report(bank: string) {
    const handle = createReconcileHandler()
    let id = 1
    const call = <K extends keyof ReconRequests>(type: K, payload: ReconRequests[K]) => handle({ id: id++, type, ...payload } as never) as Promise<never>
    const layout = { headerRecord: 1, skipTrailing: 0 }
    await call('parse', { side: 'bank', file: new File([bank], 'bank.csv'), delimiter: ',', layout })
    await call('parse', { side: 'books', file: new File(['date,amount,balance\n2026-09-01,10,1010\n'], 'books.csv'), delimiter: ',', layout })
    const { revision } = await call('normalize', { context: CONTEXT, mappings: { bank: mapping, books: mapping }, period: null })
    const { matchId } = await call('match', { revision, rules: DEFAULT_MATCHING })
    await call('setDecisions', { matchId, events: [] })
    const setup = { period: null, balances: { bank: { opening: '1000', closing: null, basis: 'cash' as const }, books: { opening: '1000', closing: null, basis: 'cash' as const } } }
    return call('accounting', { matchId, setup, basis: 'x' }) as Promise<{ running: { bank: { status: string } }; statuses: { sourcesValidated: { reasons: string[] } } }>
  }

  it('accepts a consistent running balance and reports the first break as a source issue', async () => {
    expect((await report('date,amount,balance\n2026-09-01,10,1010\n2026-09-02,-5,1005\n')).running.bank).toEqual({ status: 'consistent' })
    const broken = await report('date,amount,balance\n2026-09-01,10,1010\n2026-09-03,-5,"1,004.00"\n')
    expect(broken.running.bank.status).toBe('break')
    expect(broken.statuses.sourcesValidated.reasons).toContain('Bank: the running balance breaks at record 2 (expected 1005.00, found 1004.00)')
  })
})
