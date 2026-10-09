import { describe, expect, it } from 'vitest'
import { txnKey, unitKey } from '../../reconciliation/decisions'
import type { UnmatchedItem } from '../../worker/reconcile-protocol'
import { NO_SELECTION, selectedUnit, toggle } from './selection'

const FP = 'b'.repeat(64)

function item(record: number, group = false): UnmatchedItem {
  return {
    key: txnKey('books', FP, record),
    side: 'books',
    recordNumber: record,
    span: null,
    date: '2026-09-15',
    amount: '-1.00',
    direction: 'out',
    reference: null,
    original: { date: '2026-09-15', amount: ['-1.00'], reference: null, description: null },
    suggestions: 0,
    classification: null,
    ...(group && { group: { batch: 'PO-1', size: 2, members: [] } }),
  }
}

describe('selection', () => {
  it('toggles transactions on their own side', () => {
    const two = toggle(toggle(NO_SELECTION, item(3)), item(1))
    expect(two.books.map((t) => t.recordNumber)).toEqual([3, 1])
    expect(toggle(two, item(3)).books.map((t) => t.recordNumber)).toEqual([1])
    expect(two.bank).toEqual([])
  })

  it('is one transaction’s key, or a group key for several, never one holding a batch', () => {
    expect(selectedUnit([])).toBeNull()
    expect(selectedUnit([item(2)])).toEqual({ key: item(2).key })
    expect(selectedUnit([item(3), item(1)])).toEqual({ key: unitKey([item(1).key, item(3).key]) })
    expect(selectedUnit([item(1), item(2, true)])).toMatchObject({ error: expect.stringContaining('batch') })
  })
})
