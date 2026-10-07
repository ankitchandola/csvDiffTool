import { describe, expect, it } from 'vitest'
import { txnKey } from './decisions'
import { exportSession, importSession, readSession, SESSION_FORMAT, SessionError, type SessionFile } from './session'
import { DEFAULT_MATCHING, type SideMapping } from './types'

const FP = 'c'.repeat(64)
const B1 = txnKey('bank', FP, 1)
const L1 = txnKey('books', FP, 1)

const mapping: SideMapping = {
  delimiter: ',',
  layout: { headerRecord: 1, skipTrailing: 0 },
  date: { column: 'date', format: 'YYYY-MM-DD', kind: 'posting' },
  amount: { kind: 'signed', column: 'amount', positiveIs: 'in' },
  amountFormat: { grouped: false, trailingMinus: false, parentheses: false },
  reference: null,
  description: 'memo',
}

function session(overrides: Partial<SessionFile> = {}): SessionFile {
  return {
    format: SESSION_FORMAT,
    version: 1,
    savedAt: '2026-10-07T10:00:00.000Z',
    revision: 3,
    context: { account: 'Current', currency: 'INR', minorUnits: 2 },
    mappings: { bank: mapping, books: mapping },
    rules: DEFAULT_MATCHING,
    sources: {
      bank: { fileName: 'bank.csv', fingerprint: FP, sheet: null, recordCount: 10 },
      books: { fileName: 'books.csv', fingerprint: FP, sheet: null, recordCount: 12 },
    },
    events: [
      { seq: 1, at: '2026-10-07T10:00:00.000Z', action: 'confirm', bank: B1, books: L1, origin: 'suggested' },
      { seq: 2, at: '2026-10-07T10:01:00.000Z', action: 'unmatch', bank: B1, books: L1 },
    ],
    snapshots: [{ key: B1, date: '2026-09-01', amount: '12345678901234567890.05', direction: 'in', reference: '0007', description: null }],
    ...overrides,
  }
}

function roundTrip(file: SessionFile): SessionFile {
  return importSession(exportSession(file))
}

describe('session files', () => {
  it('round-trip exactly, keeping decimal text and leading zeros', () => {
    expect(roundTrip(session())).toEqual(session())
    expect(exportSession(session())).toContain('"amount": "12345678901234567890.05"')
  })

  it.each<[string, unknown, RegExp]>([
    ['not JSON', 'nope', /not valid JSON/],
    ['another format', { format: 'csv-diff-profile' }, /not a reconciliation session/],
    ['a newer version', { ...session(), version: 2 }, /version 2 is not supported/],
  ])('reject %s', (_, value, message) => {
    expect(() => (typeof value === 'string' ? importSession(value) : readSession(value))).toThrow(message)
  })

  it('rejects a history with gaps or contradictions', () => {
    const gap = session({ events: [{ ...session().events[1], seq: 2 }] })
    expect(() => readSession(JSON.parse(exportSession(gap)))).toThrow(/seq must be 1/)
    const contradiction = session({ events: [{ seq: 1, at: '2026-10-07T10:00:00Z', action: 'unmatch', bank: B1, books: L1 }] })
    expect(() => readSession(contradiction)).toThrow(/contradicts the history before it: This pair is not confirmed/)
  })

  it('rejects keys on the wrong side, numbers as amounts, and rule breaks without a reason', () => {
    expect(() => readSession({ ...session(), events: [{ ...session().events[0], bank: L1 }] })).toThrow(/not a bank transaction key/)
    expect(() => readSession({ ...session(), snapshots: [{ ...session().snapshots[0], amount: 12.5 }] })).toThrow(/amount must be text/)
    const manual = { seq: 1, at: '2026-10-07T10:00:00Z', action: 'confirm', bank: B1, books: L1, origin: 'manual', exceptions: ['amount'] }
    expect(() => readSession({ ...session(), events: [manual] })).toThrow(/without a reason/)
  })

  it('rejects an invalid mapping or context', () => {
    expect(() => readSession({ ...session(), context: { account: '', currency: '', minorUnits: 2 } })).toThrow(SessionError)
    const badFormat = { ...mapping, date: { ...mapping.date, format: 'D/M/Y' } }
    expect(() => readSession({ ...session(), mappings: { bank: badFormat, books: mapping } })).toThrow(/date.format must be one of/)
  })
})
