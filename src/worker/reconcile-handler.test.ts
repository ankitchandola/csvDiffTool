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
    const { revision } = await call('normalize', { context: CONTEXT, mappings: { bank: bankMapping, books: booksMapping } })
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
    const { revision } = await call('normalize', { context: CONTEXT, mappings: { bank: bankMapping, books: booksMapping } })
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
    const { revision } = await call('normalize', { context: CONTEXT, mappings: { bank: bankMapping, books: booksMapping } })
    const rerun = await call('match', { revision, rules: DEFAULT_MATCHING })
    expect(await call('setDecisions', { matchId: (rerun as { matchId: number }).matchId, events: [confirm] })).toMatchObject({ confirmed: 1, lapsed: [] })
    await call('parse', { side: 'books', file: new File([BOOKS + '\n2026-09-30,Extra,1,'], 'books.csv'), delimiter: 'auto', layout: booksMapping.layout })
    const again = await call('normalize', { context: CONTEXT, mappings: { bank: bankMapping, books: booksMapping } })
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
  }

  async function run() {
    const handle = createReconcileHandler()
    let id = 1
    const call = <K extends keyof ReconRequests>(type: K, payload: ReconRequests[K]) => handle({ id: id++, type, ...payload } as never) as Promise<never>
    await call('parse', { side: 'bank', file: new File([SET_BANK], 'bank.csv'), delimiter: ',', layout: mapping.layout })
    await call('parse', { side: 'books', file: new File([SET_BOOKS], 'books.csv'), delimiter: ',', layout: mapping.layout })
    const { revision } = await call('normalize', { context: CONTEXT, mappings: { bank: mapping, books: mapping } })
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
    const { revision } = await call('normalize', { context: CONTEXT, mappings: { bank: mapping, books: mapping } })
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
