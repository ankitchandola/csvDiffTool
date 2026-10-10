import { describe, expect, it } from 'vitest'
import { unitKey } from '../reconciliation/decisions'
import { emptyAccounting } from '../reconciliation/session'
import { DEFAULT_MATCHING, type SessionContext, type SideMapping } from '../reconciliation/types'
import { createReconcileHandler } from './reconcile-handler'
import type { DecisionSummary, ReconRequests, SuggestionItem, TransactionView, UnmatchedItem } from './reconcile-protocol'

const CONTEXT: SessionContext = { account: 'Current', currency: 'INR', minorUnits: 2 }
const AT = '2026-10-10T00:00:00.000Z'
const PERIOD = { start: '2026-09-01', end: '2026-09-30' }

const BANK = ['date,details,amount', '2026-09-05,Payout po_1,350.50', '2026-09-15,SALARY SEP/BULK,-1800.00', '2026-09-20,Payout po_2,30.00'].join('\n')

const BOOKS = [
  'date,memo,amount,payout',
  '2026-09-04,Order 1,100.00,po_1',
  '2026-09-15,Salary Anil,-650.00,',
  '2026-09-15,Salary Priya,-600.00,',
  '2026-09-15,Salary Ravi,-550.00,',
  '2026-09-04,Order 2,250.50,po_1',
  '2026-09-25,Order 3,10.00,po_2',
  '2026-09-26,Order 4,25.00,po_2',
].join('\n')

const mapping = (description: string, batch: string | null): SideMapping => ({
  delimiter: ',',
  layout: { headerRecord: 1, skipLeading: 0, skipTrailing: 0 },
  date: { column: 'date', format: 'YYYY-MM-DD', kind: 'posting' },
  amount: { kind: 'signed', column: 'amount', positiveIs: 'in' },
  amountFormat: { grouped: false, trailingMinus: false, parentheses: false },
  reference: null,
  description,
  balance: null,
  balanceMarks: 'none',
  batch,
})

async function matched({ bank = BANK, books = BOOKS, period = PERIOD, opening = null as string | null, rules = DEFAULT_MATCHING } = {}) {
  const handle = createReconcileHandler()
  let id = 1
  const call = <K extends keyof ReconRequests>(type: K, payload: ReconRequests[K]) => handle({ id: id++, type, ...payload } as never) as Promise<never>
  await call('parse', { side: 'bank', file: new File([bank], 'bank.csv'), delimiter: 'auto', layout: mapping('details', null).layout })
  await call('parse', { side: 'books', file: new File([books], 'books.csv'), delimiter: 'auto', layout: mapping('memo', 'payout').layout })
  if (opening) await call('setOpening', { files: [{ name: 'outstanding.json', text: opening }] })
  const normalized: { revision: number; sides: { books: { valid: number; batches: number } } } = await call('normalize', {
    context: CONTEXT,
    mappings: { bank: mapping('details', null), books: mapping('memo', 'payout') },
    period,
  })
  const { matchId }: { matchId: number } = await call('match', { revision: normalized.revision, rules })
  await call('setDecisions', { matchId, events: [] })
  const page = async <T,>(tab: 'suggested' | 'unmatched' | 'confirmed'): Promise<T[]> => ((await call('getReview', { matchId, tab, offset: 0, limit: 50 })) as { items: T[] }).items
  return { call, matchId, normalized, page }
}

describe('grouped matching in the worker', () => {
  it('suggests a batch against the payout and confirms it whole', async () => {
    const { call, matchId, normalized, page } = await matched()
    expect(normalized.sides.books).toMatchObject({ valid: 7, batches: 2 })
    const [payout] = await page<SuggestionItem>('suggested')
    expect(payout.bank.original.description).toBe('Payout po_1')
    expect(payout.books).toMatchObject({ amount: '350.50', date: '2026-09-04', original: { description: 'Batch po_1: 2 records' } })
    expect(payout.books.group?.members.map((m) => [m.recordNumber, m.amount])).toEqual([
      [1, '100.00'],
      [5, '250.50'],
    ])
    const result: { ok: true; snapshots: { key: string }[]; summary: DecisionSummary } = await call('decide', {
      matchId,
      seq: 1,
      at: AT,
      decision: { action: 'confirm', bank: payout.bank.key, books: payout.books.key, origin: 'suggested' },
    })
    expect(result.ok).toBe(true)
    expect(result.snapshots).toHaveLength(3)
    expect(result.summary.unmatched).toEqual({ bank: 2, books: 4 })
  })

  it('confirms a group of transactions the reviewer chose, and only an exact one', async () => {
    const { call, matchId, page } = await matched()
    const unmatched = await page<UnmatchedItem>('unmatched')
    const bulk = unmatched.find((u) => u.original.description === 'SALARY SEP/BULK') as UnmatchedItem
    const salaries = unmatched.filter((u) => u.original.description?.startsWith('Salary')).map((u) => u.key)
    const group = unitKey(salaries)
    expect(await call('checkPair', { matchId, bank: bulk.key, books: group })).toMatchObject({ blocked: null, exceptions: [], books: { amount: '-1800.00', group: { batch: null } } })
    expect(await call('checkPair', { matchId, bank: bulk.key, books: unitKey(salaries.slice(0, 2)) })).toMatchObject({ blocked: 'A group’s total must equal the other side exactly' })

    const batch = unmatched.find((u) => u.group?.batch === 'po_2') as UnmatchedItem
    const withBatchMember = unitKey([salaries[0], (batch.group as NonNullable<UnmatchedItem['group']>).members[0].key])
    expect(await call('checkPair', { matchId, bank: bulk.key, books: withBatchMember })).toMatchObject({ blocked: expect.stringMatching(/not a valid/) })

    const result: { ok: true; summary: DecisionSummary } = await call('decide', { matchId, seq: 1, at: AT, decision: { action: 'confirm', bank: bulk.key, books: group, origin: 'manual' } })
    expect(result.summary).toMatchObject({ confirmed: 1, unmatched: { bank: 2, books: 2 } })
    const [member]: { match: { event: { seq: number }; other: { amount: string } } | null }[] = await call('inspect', { matchId, keys: [salaries[1]] })
    expect(member.match).toMatchObject({ event: { seq: 1 }, other: { amount: '-1800.00' } })
    const [bank]: { match: { event: { seq: number }; other: TransactionView } | null }[] = await call('inspect', { matchId, keys: [bulk.key] })
    expect(bank.match?.other.group?.members).toHaveLength(3)
    const [confirmed] = await page<{ books: TransactionView }>('confirmed')
    expect(confirmed.books.key).toBe(group)

    const rerun: { matchId: number } = await call('match', { revision: (await call('normalize', { context: CONTEXT, mappings: { bank: mapping('details', null), books: mapping('memo', 'payout') }, period: PERIOD }) as { revision: number }).revision, rules: DEFAULT_MATCHING })
    const events = [{ seq: 1, at: AT, action: 'confirm' as const, bank: bulk.key, books: group, origin: 'manual' as const }]
    expect(await call('setDecisions', { matchId: rerun.matchId, events })).toMatchObject({ confirmed: 1, lapsed: [] })
  })

  it('carries an unmatched batch forward as one item and reports group members', async () => {
    const { call, matchId, page } = await matched()
    const [payout] = await page<SuggestionItem>('suggested')
    await call('decide', { matchId, seq: 1, at: AT, decision: { action: 'confirm', bank: payout.bank.key, books: payout.books.key, origin: 'suggested' } })
    const exported: { text: string } = await call('exportOutstanding', { matchId, sessionId: 's', period: PERIOD, exportedAt: AT })
    const items = (JSON.parse(exported.text) as { items: { amount: string; date: string; description: string; origin: { recordNumber: number } }[] }).items
    expect(items.find((i) => i.description === 'Batch po_2: 2 records')).toMatchObject({ amount: '35.00', date: '2026-09-26', origin: { recordNumber: 6 } })

    const setup = { ...emptyAccounting(), period: PERIOD }
    const blob: Blob = await call('exportReport', { matchId, format: 'json', setup, basis: 'b', session: { id: 's', revision: 1 }, generatedAt: AT })
    const report = JSON.parse(await blob.text())
    expect(report.matches[0].books).toMatchObject({ location: 'Books record 1 · line 2 and 1 more', description: 'Batch po_1: 2 records' })
    expect(report.matches[0].books.members.map((m: { location: string }) => m.location)).toEqual(['Books record 1 · line 2', 'Books record 5 · line 6'])
    expect(report.counts.books).toMatchObject({ rows: 7, valid: 7, invalid: 0 })
  })

  it('clears carried items matched as a group next month, and never carries them again', async () => {
    const sep = await matched({ bank: ['date,details,amount', '2026-09-05,Payout po_1,350.50'].join('\n') })
    const [payout] = await sep.page<SuggestionItem>('suggested')
    await sep.call('decide', { matchId: sep.matchId, seq: 1, at: AT, decision: { action: 'confirm', bank: payout.bank.key, books: payout.books.key, origin: 'suggested' } })
    const carried: { text: string; items: number } = await sep.call('exportOutstanding', { matchId: sep.matchId, sessionId: 'sep', period: PERIOD, exportedAt: AT })
    expect(carried.items).toBe(4)

    const oct = await matched({
      bank: ['date,details,amount', '2026-10-01,SALARY SEP/BULK,-1800.00', '2026-10-01,Payout po_2,35.00'].join('\n'),
      books: ['date,memo,amount,payout', '2026-10-03,Office rent,-500.00,'].join('\n'),
      period: { start: '2026-10-01', end: '2026-10-31' },
      opening: carried.text,
      rules: { ...DEFAULT_MATCHING, bankDaysBefore: 7, bankDaysAfter: 7 },
    })
    const [po2] = await oct.page<SuggestionItem>('suggested')
    expect(po2.books).toMatchObject({ amount: '35.00', carried: { fileName: 'books.csv' } })
    await oct.call('decide', { matchId: oct.matchId, seq: 1, at: AT, decision: { action: 'confirm', bank: po2.bank.key, books: po2.books.key, origin: 'suggested' } })

    const unmatched = await oct.page<UnmatchedItem>('unmatched')
    const bulk = unmatched.find((u) => u.side === 'bank') as UnmatchedItem
    const salaries = unitKey(unmatched.filter((u) => u.carried).map((u) => u.key))
    expect(await oct.call('checkPair', { matchId: oct.matchId, bank: bulk.key, books: salaries })).toMatchObject({ blocked: null, exceptions: ['date'] })
    const decision = { action: 'confirm' as const, bank: bulk.key, books: salaries, origin: 'manual' as const, exceptions: ['date' as const], reason: 'September salaries paid on 1 October' }
    expect(await oct.call('decide', { matchId: oct.matchId, seq: 2, at: AT, decision })).toMatchObject({ ok: true, summary: { unmatched: { bank: 0, books: 1 } } })

    const next: { text: string } = await oct.call('exportOutstanding', { matchId: oct.matchId, sessionId: 'oct', period: { start: '2026-10-01', end: '2026-10-31' }, exportedAt: AT })
    const file = JSON.parse(next.text) as { items: { description: string }[]; cleared: string[] }
    expect(file.items.map((i) => i.description)).toEqual(['Office rent'])
    expect(file.cleared).toHaveLength(4)
  })
})

describe('a large batch', () => {
  // About a second alone; the timeout leaves room for a busy machine, such as the browser suite running beside it.
  it('matches 50,000 charges in one payout exactly, and keeps its key compact', { timeout: 20_000 }, async () => {
    const charges = Array.from({ length: 50_000 }, (_, i) => `2026-09-${String(1 + (i % 28)).padStart(2, '0')},Charge ${i},1.01,po_big`)
    const started = performance.now()
    const { call, matchId, page } = await matched({
      bank: ['date,details,amount', '2026-09-28,Payout po_big,50500.00'].join('\n'),
      books: ['date,memo,amount,payout', ...charges].join('\n'),
    })
    const [payout] = await page<SuggestionItem>('suggested')
    expect(payout.books).toMatchObject({ amount: '50500.00', date: '2026-09-28' })
    expect(payout.books.key.length).toBeLessThan(400_000)
    expect([payout.books.group?.size, payout.books.group?.members.length]).toEqual([50_000, 50])
    const found: { total: number } = await call('getReview', { matchId, tab: 'suggested', offset: 0, limit: 10, search: 'charge 49999' })
    expect(found.total).toBe(1)
    const result: { ok: boolean } = await call('decide', { matchId, seq: 1, at: AT, decision: { action: 'confirm', bank: payout.bank.key, books: payout.books.key, origin: 'suggested' } })
    expect(result.ok).toBe(true)
    expect(performance.now() - started).toBeLessThan(10_000)
  })
})
