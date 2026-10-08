import { describe, expect, it } from 'vitest'
import { dayNumber } from './dates'
import { checkImport, type OutstandingFile, readOutstandingFile } from './carryforward'
import type { SessionContext, Transaction } from './types'

const CONTEXT: SessionContext = { account: 'Current', currency: 'INR', minorUnits: 2 }
const FP = 'a'.repeat(64)

function file(overrides: Partial<OutstandingFile> = {}): OutstandingFile {
  return {
    format: 'reconciliation-outstanding',
    version: 1,
    exportedAt: '2026-10-01T00:00:00.000Z',
    sessionId: 'sep',
    account: 'Current',
    currency: 'INR',
    minorUnits: 2,
    period: { start: '2026-09-01', end: '2026-09-30' },
    items: [
      {
        lineage: `books|${FP}|3`,
        side: 'books',
        date: '2026-09-29',
        amount: '-200.00',
        direction: 'out',
        reference: 'CHQ101',
        description: 'Cheque 101',
        origin: { sessionId: 'sep', period: { start: '2026-09-01', end: '2026-09-30' }, fileName: 'books-sep.csv', fingerprint: FP, recordNumber: 3 },
      },
    ],
    cleared: [],
    ...overrides,
  }
}

const OCT = { start: '2026-10-01', end: '2026-10-31' }

function target(current: Partial<Record<'bank' | 'books', Transaction[]>> = {}, imported = new Set<string>(), clearedElsewhere = new Set<string>()) {
  return { context: CONTEXT, period: OCT, imported, clearedElsewhere, current: { bank: current.bank ?? [], books: current.books ?? [] } }
}

describe('readOutstandingFile', () => {
  it('reads exact decimal text and rejects inconsistent items', () => {
    expect(readOutstandingFile(JSON.parse(JSON.stringify(file())))).toEqual(file())
    const bad = (item: object) => () => readOutstandingFile({ ...file(), items: [{ ...file().items[0], ...item }] })
    expect(bad({ amount: -200 })).toThrow('amount must be text')
    expect(bad({ amount: '-200.001' })).toThrow('at most 2 decimal places')
    expect(bad({ direction: 'in' })).toThrow("direction does not match the amount's sign")
    expect(() => readOutstandingFile({ ...file(), version: 2 })).toThrow('version 2 is not supported')
  })
})

describe('checkImport', () => {
  it('accepts the previous consecutive period', () => {
    expect(checkImport(file(), target())).toEqual({ errors: [], warnings: [], overlaps: [] })
  })

  it('refuses duplicate lineage, items imported already, and items also listed as cleared', () => {
    const item = file().items[0]
    expect(checkImport(file({ items: [item, item] }), target()).errors).toEqual([`Item ${item.lineage} appears more than once in the file`])
    expect(checkImport(file(), target({}, new Set([item.lineage]))).errors).toEqual([`Item ${item.lineage} is already imported into this session`])
    expect(checkImport(file({ cleared: [item.lineage] }), target()).errors).toEqual([`Item ${item.lineage} is listed as cleared and as outstanding`])
  })

  it('refuses an item a file imported earlier says was cleared, in either order', () => {
    const lineage = file().items[0].lineage
    expect(checkImport(file(), target({}, new Set(), new Set([lineage]))).errors).toEqual([
      `Item ${lineage} was already cleared according to a file imported earlier; it can't be outstanding again`,
    ])
    expect(checkImport(file({ items: [], cleared: [lineage] }), target({}, new Set([lineage]))).errors).toEqual([
      `The file says ${lineage} was cleared, but it is imported here as outstanding`,
    ])
  })

  it('refuses another account, currency or an overlapping period, and warns on a gap', () => {
    expect(checkImport(file({ currency: 'USD' }), target()).errors[0]).toMatch(/USD/)
    expect(checkImport(file({ account: 'Savings' }), target()).errors[0]).toMatch(/Savings/)
    expect(checkImport(file({ period: { start: '2026-09-01', end: '2026-10-05' } }), target()).errors[0]).toMatch(/not before this session's period starts/)
    expect(checkImport(file({ period: { start: '2026-08-01', end: '2026-08-31' } }), target()).warnings[0]).toMatch(/not consecutive/)
  })

  it('flags a current transaction that repeats a carried item, for review rather than removal', () => {
    const repeat: Transaction = { side: 'books', index: 0, day: dayNumber(2026, 9, 29), amount: { units: -20000n, scale: 2 }, reference: 'CHQ101' }
    const check = checkImport(file(), target({ books: [repeat] }))
    expect(check.errors).toEqual([])
    expect(check.overlaps).toEqual([{ lineage: file().items[0].lineage, side: 'books', current: [0] }])
    expect(check.warnings[0]).toMatch(/overlapping export/)
  })
})
