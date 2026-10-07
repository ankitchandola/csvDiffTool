import { describe, expect, it } from 'vitest'
import { checkDecision, checkPair, type DecisionEvent, edgeKey, emptyState, parseTxnKey, replay, type ReplayData, txnKey } from './decisions'
import { DEFAULT_MATCHING, type Transaction } from './types'

const FP_BANK = 'a'.repeat(64)
const FP_BOOKS = 'b'.repeat(64)
const B1 = txnKey('bank', FP_BANK, 1)
const B2 = txnKey('bank', FP_BANK, 2)
const L1 = txnKey('books', FP_BOOKS, 1)
const L2 = txnKey('books', FP_BOOKS, 2)

function t(side: 'bank' | 'books', index: number, day: number, units: number, reference: string | null = null): Transaction {
  return { side, index, day, amount: { units: BigInt(units), scale: 2 }, reference }
}

const TXNS: Record<string, Transaction> = {
  [B1]: t('bank', 0, 100, 500),
  [B2]: t('bank', 1, 100, -500),
  [L1]: t('books', 0, 101, 500),
  [L2]: t('books', 1, 120, 700),
}

function data(overrides: Partial<ReplayData> = {}): ReplayData {
  return {
    transaction: (key) => TXNS[key],
    isCandidate: (bank, books) => bank === B1 && books === L1,
    sourcePresent: () => true,
    rules: DEFAULT_MATCHING,
    ...overrides,
  }
}

let seq = 0
function ev(action: DecisionEvent['action'], bank: string, books: string, extra: Partial<DecisionEvent> = {}): DecisionEvent {
  return { seq: ++seq, at: '2026-10-07T00:00:00Z', action, bank, books, ...(action === 'confirm' ? { origin: 'suggested' as const } : {}), ...extra }
}

describe('transaction keys', () => {
  it('round-trip and reject malformed keys', () => {
    expect(parseTxnKey(B1)).toEqual({ side: 'bank', fingerprint: FP_BANK, recordNumber: 1 })
    expect(parseTxnKey('bank|abc|1')).toBeNull()
    expect(parseTxnKey(`ledger|${FP_BANK}|1`)).toBeNull()
    expect(parseTxnKey(`bank|${FP_BANK}|0`)).toBeNull()
  })
})

describe('checkPair', () => {
  it('blocks opposite directions and invalid transactions', () => {
    expect(checkPair(TXNS[B2], TXNS[L1], DEFAULT_MATCHING).blocked).toBe('Money in cannot pair with money out')
    expect(checkPair(undefined, TXNS[L1], DEFAULT_MATCHING).blocked).toMatch(/not a valid/)
  })

  it('lists the soft rules a pair breaks', () => {
    expect(checkPair(TXNS[B1], TXNS[L2], DEFAULT_MATCHING).exceptions).toEqual(['amount', 'date'])
    const refs = { ...DEFAULT_MATCHING, referencesShared: true }
    expect(checkPair(t('bank', 0, 1, 5, 'A'), t('books', 0, 1, 5, 'B'), refs).exceptions).toEqual(['reference'])
    expect(checkPair(t('bank', 0, 1, 5, 'a'), t('books', 0, 1, 5, 'A'), { ...refs, referenceCaseInsensitive: true }).exceptions).toEqual([])
  })
})

describe('checkDecision', () => {
  it('confirms a current suggestion and consumes both transactions once', () => {
    const r = replay([ev('confirm', B1, L1)], data())
    expect(r.lapsed).toEqual([])
    expect(r.state.bankMatch.get(B1)).toBe(L1)
    expect(checkDecision(r.state, { action: 'confirm', bank: B1, books: L2, origin: 'manual', exceptions: ['amount', 'date'], reason: 'x' }, data())).toEqual({
      ok: false,
      reason: 'The bank transaction is already in a confirmed match',
    })
  })

  it('requires a reason and the exact exceptions for a manual pair that breaks rules', () => {
    const state = emptyState()
    expect(checkDecision(state, { action: 'confirm', bank: B1, books: L2, origin: 'manual' }, data())).toEqual({
      ok: false,
      reason: 'Give a reason: amounts differ, dates are outside the window',
    })
    expect(checkDecision(state, { action: 'confirm', bank: B1, books: L2, origin: 'manual', exceptions: ['amount', 'date'], reason: '  ' }, data()).ok).toBe(false)
    expect(checkDecision(state, { action: 'confirm', bank: B1, books: L2, origin: 'manual', exceptions: ['amount', 'date'], reason: 'Fee deducted' }, data())).toEqual({ ok: true })
  })

  it('never lets a manual pair cross cash directions', () => {
    expect(checkDecision(emptyState(), { action: 'confirm', bank: B2, books: L1, origin: 'manual', exceptions: ['amount'], reason: 'r' }, data())).toEqual({
      ok: false,
      reason: 'Money in cannot pair with money out',
    })
  })

  it('refuses a suggested confirm that is no longer a candidate', () => {
    expect(checkDecision(emptyState(), { action: 'confirm', bank: B1, books: L2, origin: 'suggested' }, data()).ok).toBe(false)
  })
})

describe('reject, restore and unmatch', () => {
  it('keeps a rejection, blocks confirming it, and restores it', () => {
    const rejected = replay([ev('reject', B1, L1)], data())
    expect(rejected.state.rejected.has(edgeKey(B1, L1))).toBe(true)
    expect(checkDecision(rejected.state, { action: 'confirm', bank: B1, books: L1, origin: 'suggested' }, data()).ok).toBe(false)
    const restored = replay([ev('reject', B1, L1), ev('restore', B1, L1), ev('confirm', B1, L1)], data())
    expect(restored.state.active.size).toBe(1)
  })

  it('requires unmatching before rejecting a confirmed pair, and frees both sides on unmatch', () => {
    const confirmed = replay([ev('confirm', B1, L1)], data())
    expect(checkDecision(confirmed.state, { action: 'reject', bank: B1, books: L1 }, data()).ok).toBe(false)
    const unmatched = replay([ev('confirm', B1, L1), ev('unmatch', B1, L1)], data())
    expect(unmatched.state.bankMatch.size).toBe(0)
    expect(unmatched.state.booksMatch.size).toBe(0)
  })
})

describe('replay', () => {
  it('lapses decisions whose source changed instead of applying them', () => {
    const r = replay([ev('confirm', B1, L1), ev('reject', B2, L2)], data({ sourcePresent: (key) => key !== L1 }))
    expect(r.state.active.size).toBe(0)
    expect(r.state.rejected.size).toBe(1)
    expect(r.lapsed.map((l) => [l.event.action, l.reason])).toEqual([['confirm', 'Its source file was replaced or is not loaded']])
  })

  it('lapses a suggested confirm that the current rules no longer suggest, and skips its unmatch', () => {
    const r = replay([ev('confirm', B1, L1), ev('unmatch', B1, L1)], data({ isCandidate: () => false }))
    expect(r.lapsed).toHaveLength(1)
    expect(r.state.active.size).toBe(0)
  })

  it('keeps a manual confirm whose recorded exceptions still cover the rules it breaks', () => {
    const manual = ev('confirm', B1, L2, { origin: 'manual', exceptions: ['amount', 'date'], reason: 'Fee' })
    expect(replay([manual], data()).state.active.size).toBe(1)
    const narrower = replay([ev('confirm', B1, L2, { origin: 'manual', exceptions: ['amount'], reason: 'Fee' })], data())
    expect(narrower.lapsed[0].reason).toMatch(/dates are outside the window/)
  })

  it('keeps rejections when only the rules change', () => {
    const r = replay([ev('reject', B1, L1)], data({ isCandidate: () => false, rules: { ...DEFAULT_MATCHING, bankDaysAfter: 0 } }))
    expect(r.state.rejected.size).toBe(1)
  })
})
