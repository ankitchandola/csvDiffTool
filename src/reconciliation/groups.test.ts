import { describe, expect, it } from 'vitest'
import type { ParsedFile } from '../engine/types'
import { applyToState, checkDecision, checkPair, emptyState, eventKeys, type PairEvent, parseUnitKey, replay, type ReplayData, txnKey, unitKey } from './decisions'
import { groupOf } from './groups'
import { normalizeSide } from './normalize'
import { DEFAULT_MATCHING, type SideMapping, type Transaction } from './types'

const FP_BANK = 'a'.repeat(64)
const FP_BOOKS = 'b'.repeat(64)
const FP_OPENING = 'c'.repeat(64)
const B1 = txnKey('bank', FP_BANK, 1)
const L1 = txnKey('books', FP_BOOKS, 1)
const L2 = txnKey('books', FP_BOOKS, 2)
const L3 = txnKey('books', FP_BOOKS, 3)
const L10 = txnKey('books', FP_BOOKS, 10)
const CARRIED = txnKey('books', FP_OPENING, 1)

function t(side: 'bank' | 'books', index: number, day: number, units: number, opening = false): Transaction {
  return { side, index, day, amount: { units: BigInt(units), scale: 2 }, reference: null, ...(opening && { opening: { file: 0, item: index } }) }
}

describe('unit keys', () => {
  it('are a single transaction key for one member', () => {
    expect(unitKey([L1])).toBe(L1)
    expect(parseUnitKey(L1)).toEqual({ side: 'books', members: [L1] })
  })

  it('list a group’s members in one canonical order, whatever order they are given in', () => {
    const key = unitKey([L10, CARRIED, L2])
    expect(key).toBe(`books|${FP_BOOKS}|2+10&books|${FP_OPENING}|1`)
    expect(unitKey([L2, L10, CARRIED])).toBe(key)
    expect(parseUnitKey(key)).toEqual({ side: 'books', members: [L2, L10, CARRIED] })
  })

  it('refuse mixed sides, repeats and keys not in canonical form', () => {
    expect(() => unitKey([B1, L1])).toThrow('one side only')
    expect(() => unitKey([L1, L1])).toThrow('twice')
    expect(parseUnitKey(`books|${FP_BOOKS}|10+2`)).toBeNull()
    expect(parseUnitKey(`books|${FP_BOOKS}|1+1`)).toBeNull()
    expect(parseUnitKey(`books|${FP_BOOKS}|1&bank|${FP_BANK}|2`)).toBeNull()
    expect(parseUnitKey(`books|${FP_BOOKS}|1+x`)).toBeNull()
  })
})

describe('groups in checkPair', () => {
  const salary = groupOf([t('books', 0, 100, -6500000), t('books', 1, 101, -6000000), t('books', 2, 100, -5500000)])

  it('sum the members exactly, dated by the latest one', () => {
    expect(salary.amount.units).toBe(-18000000n)
    expect(salary.day).toBe(101)
    expect(checkPair(t('bank', 0, 101, -18000000), salary, DEFAULT_MATCHING)).toEqual({ blocked: null, exceptions: [] })
  })

  it('must equal the other side exactly; a date outside the window is a reasoned exception', () => {
    expect(checkPair(t('bank', 0, 101, -17999900), salary, DEFAULT_MATCHING).blocked).toBe('A group’s total must equal the other side exactly')
    expect(checkPair(t('bank', 0, 110, -18000000), salary, DEFAULT_MATCHING)).toEqual({ blocked: null, exceptions: ['date'] })
  })

  it('block mixed directions, a chosen group on both sides and carried items alone', () => {
    const mixed = groupOf([t('books', 0, 100, -500), t('books', 1, 100, 200)])
    expect(checkPair(t('bank', 0, 100, -300), mixed, DEFAULT_MATCHING).blocked).toBe('A group’s transactions must all be money in or all money out')
    const bankGroup = groupOf([t('bank', 0, 100, -500), t('bank', 1, 100, -500)])
    const booksGroup = groupOf([t('books', 0, 100, -600), t('books', 1, 100, -400)])
    expect(checkPair(bankGroup, booksGroup, DEFAULT_MATCHING).blocked).toBe('Only one side of a match can hold several transactions')
    const batches = [groupOf([t('bank', 0, 100, -500), t('bank', 1, 100, -500)], 'P1'), groupOf([t('books', 0, 100, -600), t('books', 1, 100, -400)], 'P1')]
    expect(checkPair(batches[0], batches[1], DEFAULT_MATCHING).blocked).toBeNull()
    const carried = groupOf([t('books', 0, 100, -500, true), t('books', 1, 100, -500, true)])
    expect(checkPair(t('bank', 0, 100, -1000, true), carried, DEFAULT_MATCHING).blocked).toMatch(/carried items can’t clear each other/)
    const partly = groupOf([t('books', 0, 100, -500, true), t('books', 1, 100, -500)])
    expect(checkPair(t('bank', 0, 100, -1000, true), partly, DEFAULT_MATCHING).blocked).toBeNull()
  })
})

describe('group decisions', () => {
  const GROUP = unitKey([L1, L2, L3])
  const members: Record<string, Transaction> = {
    [B1]: t('bank', 0, 100, -18000000),
    [L1]: t('books', 0, 100, -6500000),
    [L2]: t('books', 1, 100, -6000000),
    [L3]: t('books', 2, 100, -5500000),
  }
  const data: ReplayData = {
    transaction: (key) => members[key],
    unit: (key) => members[key] ?? groupOf((parseUnitKey(key)?.members ?? []).map((m) => members[m])),
    isCandidate: () => false,
    sourcePresent: () => true,
    rules: DEFAULT_MATCHING,
  }
  const at = '2026-10-10T00:00:00Z'
  const confirm: PairEvent = { seq: 1, at, action: 'confirm', bank: B1, books: GROUP, origin: 'manual' }

  it('take every member at once, and unmatching frees them all', () => {
    const state = replay([confirm], data).state
    expect([L1, L2, L3].map((key) => state.booksMatch.get(key)?.seq)).toEqual([1, 1, 1])
    expect(checkDecision(state, { action: 'confirm', bank: B1, books: L2, origin: 'manual', exceptions: ['amount'], reason: 'x' }, data)).toEqual({
      ok: false,
      reason: 'The bank transaction is already in a confirmed match',
    })
    expect(checkDecision(state, { action: 'classify', key: L3, classification: 'investigate' }, data)).toEqual({ ok: false, reason: 'A transaction in a confirmed match is not classified' })
    applyToState(state, { seq: 2, at, action: 'unmatch', bank: B1, books: GROUP })
    expect(state.booksMatch.size).toBe(0)
    expect(state.bankMatch.size).toBe(0)
  })

  it('keep a member out of a group while it is matched on its own', () => {
    const state = emptyState()
    applyToState(state, { ...confirm, books: L2, origin: 'manual', exceptions: ['amount'], reason: 'x' })
    expect(checkDecision(state, { action: 'confirm', bank: B1, books: GROUP, origin: 'manual' }, data)).toMatchObject({ ok: false })
  })

  it('list each member as a transaction the event is about', () => {
    expect(eventKeys(confirm)).toEqual([B1, L1, L2, L3])
  })

  it('never come from a suggestion: a chosen group is confirmed by hand', () => {
    expect(checkDecision(emptyState(), { action: 'confirm', bank: B1, books: GROUP, origin: 'suggested' }, data)).toEqual({
      ok: false,
      reason: 'This pair is no longer suggested under the current rules',
    })
  })
})

describe('batches in normalizeSide', () => {
  const mapping: SideMapping = {
    delimiter: ',',
    layout: { headerRecord: 1, skipLeading: 0, skipTrailing: 0 },
    date: { column: 'date', format: 'YYYY-MM-DD', kind: 'posting' },
    amount: { kind: 'signed', column: 'amount', positiveIs: 'in' },
    amountFormat: { grouped: false, trailingMinus: false, parentheses: false },
    reference: null,
    description: null,
    balance: null,
    balanceMarks: 'none',
    batch: 'payout',
  }
  const file = (rows: [string, string, string][]): ParsedFile => ({
    headers: ['date', 'amount', 'payout'],
    rows: rows.map(([date, amount, payout]) => ({ date, amount, payout })),
    format: { kind: 'csv', delimiter: ',' },
    notes: [],
  })
  const context = { account: '', currency: 'INR', minorUnits: 2 }

  it('match rows sharing a batch ID as one group, and rows without one on their own', () => {
    const side = normalizeSide(
      'books',
      file([
        ['2026-09-01', '100', 'po_1'],
        ['2026-09-02', '5', ''],
        ['2026-09-03', '250.50', ' po_1 '],
        ['2026-09-03', '7', 'po_2'],
      ]),
      mapping,
      context,
    )
    expect(side.transactions).toHaveLength(4)
    expect(side.units.map((u) => [u.index, u.amount.units, u.batch ?? null, u.members?.length ?? 1])).toEqual([
      [0, 35050n, 'po_1', 2],
      [1, 500n, null, 1],
      [3, 700n, null, 1],
    ])
  })

  it('keep a batch with an invalid record or with money in and out out of matching, as problems', () => {
    const side = normalizeSide(
      'books',
      file([
        ['2026-09-01', '100', 'po_1'],
        ['2026-09-02', 'x', 'po_1'],
        ['2026-09-03', '50', 'po_2'],
        ['2026-09-03', '-20', 'po_2'],
        ['2026-09-04', '0', 'po_3'],
        ['2026-09-04', '9', 'po_3'],
      ]),
      mapping,
      context,
    )
    expect(side.units.map((u) => u.index)).toEqual([5])
    expect(side.problems.filter((p) => p.field === 'batch').map((p) => [p.index, p.message])).toEqual([
      [0, 'Batch “po_1” has an invalid record, so none of the batch is matched'],
      [2, 'Batch “po_2” has money in and money out; matching its net amount isn’t supported'],
      [3, 'Batch “po_2” has money in and money out; matching its net amount isn’t supported'],
    ])
    expect(side.zero).toEqual([4])
  })
})
