import { describe, expect, it } from 'vitest'
import { type Decimal, formatDecimal, parseDecimal } from '../engine/decimal'
import { cashBalance, checkRunningBalance, checkSource, computeBridge, type BridgeInput } from './accounting'

function d(text: string): Decimal {
  const value = parseDecimal(text)
  if (!value) throw new Error(text)
  return value
}

const none = { bank: [], books: [] }

function input(overrides: Partial<BridgeInput> = {}): BridgeInput {
  return {
    sides: {
      bank: { balances: { opening: d('0'), closing: d('100') }, movement: d('100'), invalidRows: 0 },
      books: { balances: { opening: d('0'), closing: d('100') }, movement: d('100'), invalidRows: 0 },
    },
    openingAll: none,
    openingRemaining: none,
    unmatched: { bank: [d('100')], books: [d('100')] },
    confirmedDifferences: [],
    incompleteSearch: false,
    ...overrides,
  }
}

describe('checkSource', () => {
  it('validates opening plus movement against closing, exactly', () => {
    expect(checkSource({ balances: { opening: d('1000.00'), closing: d('1100.00') }, movement: d('100'), invalidRows: 0 })).toEqual({ status: 'validated' })
    const mismatch = checkSource({ balances: { opening: d('1000.00'), closing: d('1100.01') }, movement: d('100'), invalidRows: 0 })
    expect(mismatch.status === 'mismatch' && formatDecimal(mismatch.difference)).toBe('0.01')
  })

  it('never validates while a row is invalid, even if the totals happen to agree', () => {
    expect(checkSource({ balances: { opening: d('0'), closing: d('0') }, movement: d('0'), invalidRows: 1 })).toEqual({ status: 'invalid-rows', invalidRows: 1 })
  })

  it('needs both balances', () => {
    expect(checkSource({ balances: { opening: d('0'), closing: null }, movement: d('0'), invalidRows: 0 })).toEqual({ status: 'missing-balances' })
  })

  it('turns liability-basis balances into cash terms', () => {
    expect(formatDecimal(cashBalance(d('250.00'), 'liability'))).toBe('-250.00')
    expect(formatDecimal(cashBalance(d('250.00'), 'cash'))).toBe('250.00')
  })
})

describe('checkRunningBalance', () => {
  it('reports the first break, which exposes a missing row', () => {
    const rows = [
      { amount: d('10'), balance: d('110') },
      { amount: d('-5'), balance: d('100') },
      { amount: d('1'), balance: d('101') },
    ]
    const check = checkRunningBalance(d('100'), rows)
    expect(check.status === 'break' && [check.first.row, formatDecimal(check.first.expected), formatDecimal(check.first.found)]).toEqual([2, '105', '100'])
  })

  it('stops at a row it cannot read', () => {
    expect(checkRunningBalance(d('0'), [{ amount: d('1'), balance: d('1') }, { amount: null, balance: d('2') }])).toEqual({ status: 'unreadable', row: 2 })
    expect(checkRunningBalance(d('0'), [{ amount: d('1'), balance: d('1') }])).toEqual({ status: 'consistent' })
  })
})

describe('computeBridge', () => {
  it('balances as an identity even when nothing was reviewed', () => {
    // The spec's example: the same receipt on both sides, left unmatched, still bridges.
    const bridge = computeBridge(input())
    expect(bridge.complete).toBe(true)
    expect(bridge.unexplained && formatDecimal(bridge.unexplained)).toBe('0')
  })

  it('is incomplete when the opening difference is not covered by opening items', () => {
    const bridge = computeBridge(
      input({
        sides: {
          bank: { balances: { opening: d('50'), closing: d('150') }, movement: d('100'), invalidRows: 0 },
          books: { balances: { opening: d('0'), closing: d('100') }, movement: d('100'), invalidRows: 0 },
        },
      }),
    )
    expect(bridge.complete).toBe(false)
    expect(bridge.opening.status).toBe('uncovered')
    expect(bridge.gaps).toContain('The opening difference is not fully covered by opening items')
  })

  it('is incomplete with invalid rows or an incomplete search, and says why', () => {
    const invalid = computeBridge(input({ sides: { ...input().sides, books: { ...input().sides.books, invalidRows: 2 } } }))
    expect(invalid.complete).toBe(false)
    expect(invalid.gaps).toEqual(['Books: 2 invalid records have no trustworthy amount'])
    const one = computeBridge(input({ sides: { ...input().sides, bank: { ...input().sides.bank, invalidRows: 1 } } }))
    expect(one.gaps).toEqual(['Bank: 1 invalid record has no trustworthy amount'])
    expect(computeBridge(input({ incompleteSearch: true })).gaps).toEqual(['The candidate search is incomplete'])
  })
})
