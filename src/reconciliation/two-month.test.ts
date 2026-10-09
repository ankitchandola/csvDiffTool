import { describe, expect, it } from 'vitest'
import { type Decimal, formatDecimal, parseDecimal } from '../engine/decimal'
import { parseCsv } from '../engine/parse'
import { computeBridge, sum } from './accounting'
import { buildOutstandingFile, checkImport, type OutstandingFile, type OutstandingSource, openingTransactions, readOutstandingFile } from './carryforward'
import { isoDate } from './dates'
import { findCandidates } from './match'
import { normalizeSide } from './normalize'
import { DEFAULT_MATCHING, type MatchingRules, type ReconSide, type SessionContext, type SideMapping, type Transaction } from './types'

// The spec's worked two-month example (section 9), run through the real parser,
// normalization, matching, bridge and carry-forward, plus the cases the release fixture
// adds: a cheque that clears later than the window, repeated identical transactions and
// an overlapping export.

const CONTEXT: SessionContext = { account: 'Current', currency: 'INR', minorUnits: 2 }
const SEP = { start: '2026-09-01', end: '2026-09-30' }
const OCT = { start: '2026-10-01', end: '2026-10-31' }
const FP: Record<string, string> = { 'bank-sep': '1'.repeat(64), 'books-sep': '2'.repeat(64), 'bank-oct': '3'.repeat(64), 'books-oct': '4'.repeat(64) }

const mapping = (format: 'DD/MM/YYYY' | 'YYYY-MM-DD'): SideMapping => ({
  delimiter: ',',
  layout: { headerRecord: 1, skipLeading: 0, skipTrailing: 0 },
  date: { column: 'date', format, kind: 'posting' },
  amount: { kind: 'signed', column: 'amount', positiveIs: 'in' },
  amountFormat: { grouped: true, trailingMinus: false, parentheses: false },
  reference: 'ref',
  description: 'memo',
  balance: null,
  balanceMarks: 'none',
  batch: null,
})

const BANK_SEP = 'date,amount,ref,memo\n11/09/2026,300.00,,Receipt\n'
const BOOKS_SEP = 'date,amount,ref,memo\n2026-09-10,300.00,,Receipt\n2026-09-15,-50.00,CHQ102,Cheque 102 issued\n2026-09-29,-200.00,CHQ101,Cheque 101 issued\n'
const BANK_OCT =
  'date,amount,ref,memo\n02/10/2026,-200.00,CHQ101,Cheque 101 cleared\n05/10/2026,-9.99,,NETFLIX\n05/10/2026,-9.99,,NETFLIX\n20/10/2026,-50.00,CHQ102,Cheque 102 cleared\n31/10/2026,-10.00,,Bank charge\n'
const BOOKS_OCT = 'date,amount,ref,memo\n2026-10-05,-9.99,,Netflix\n2026-10-05,-9.99,,Netflix\n2026-10-30,500.00,,Receipt\n'
// The same October books export, started on 29 September: it repeats cheque 101.
const BOOKS_OCT_OVERLAP = 'date,amount,ref,memo\n2026-09-29,-200.00,CHQ101,Cheque 101 issued\n' + BOOKS_OCT.split('\n').slice(1).join('\n')

function d(text: string): Decimal {
  return parseDecimal(text) as Decimal
}

interface Month {
  current: Record<ReconSide, Transaction[]>
  opening: Record<ReconSide, Transaction[]>
  rows: Record<ReconSide, Record<string, string>[]>
  fileNames: Record<ReconSide, string>
  openingFile: OutstandingFile | null
  // Pool positions confirmed together: current transactions first, then opening items.
  confirmed: [number, number][]
  pool: Record<ReconSide, Transaction[]>
  candidates: ReturnType<typeof findCandidates>
}

function month(bankCsv: string, booksCsv: string, names: Record<ReconSide, string>, rules: MatchingRules, openingFile: OutstandingFile | null = null): Month {
  const read = (text: string) => {
    const outcome = parseCsv(text, { delimiter: ',', trimHeaders: true })
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
    return outcome.file
  }
  const bankFile = read(bankCsv)
  const booksFile = read(booksCsv)
  const current = {
    bank: normalizeSide('bank', bankFile, mapping('DD/MM/YYYY'), CONTEXT).transactions,
    books: normalizeSide('books', booksFile, mapping('YYYY-MM-DD'), CONTEXT).transactions,
  }
  const opening = {
    bank: openingFile ? openingTransactions(openingFile, 'bank', CONTEXT.minorUnits) : [],
    books: openingFile ? openingTransactions(openingFile, 'books', CONTEXT.minorUnits) : [],
  }
  const pool = { bank: [...current.bank, ...opening.bank], books: [...current.books, ...opening.books] }
  return {
    current,
    opening,
    rows: { bank: bankFile.rows, books: booksFile.rows },
    fileNames: names,
    openingFile,
    confirmed: [],
    pool,
    candidates: findCandidates(pool.bank, pool.books, rules),
  }
}

// Confirms the suggested pair whose bank row has this memo and books item this description,
// enforcing one confirmed match per transaction.
function confirm(m: Month, bankMemo: string, booksText: string, nth = 0) {
  const memo = (side: ReconSide, position: number) => {
    const t = m.pool[side][position]
    const isOpening = position >= m.current[side].length
    if (!isOpening) return m.rows[side][t.index].memo
    return (m.openingFile as OutstandingFile).items.filter((i) => i.side === side)[t.index].description
  }
  const used = (side: 0 | 1, p: number) => m.confirmed.some((pair) => pair[side] === p)
  const found = m.candidates.candidates.filter((c) => memo('bank', c.bank) === bankMemo && memo('books', c.books) === booksText && !used(0, c.bank) && !used(1, c.books))
  if (!found[nth]) throw new Error(`no open suggestion for ${bankMemo} ↔ ${booksText}`)
  m.confirmed.push([found[nth].bank, found[nth].books])
}

function bridge(m: Month, balances: Record<ReconSide, [string, string]>) {
  return computeBridge(bridgeInputs(m, balances))
}

function outstanding(m: Month, sessionId: string, period: { start: string; end: string }): OutstandingFile {
  const used = { bank: new Set(m.confirmed.map((p) => p[0])), books: new Set(m.confirmed.map((p) => p[1])) }
  const items: OutstandingSource[] = []
  const cleared: string[] = []
  for (const side of ['bank', 'books'] as const) {
    m.pool[side].forEach((t, position) => {
      const isOpening = position >= m.current[side].length
      const carried = isOpening ? (m.openingFile as OutstandingFile).items.filter((i) => i.side === side)[t.index] : null
      if (used[side].has(position)) {
        if (carried) cleared.push(carried.lineage)
        return
      }
      items.push({
        transaction: t,
        description: carried ? carried.description : m.rows[side][t.index].memo,
        carried,
        provenance: carried
          ? carried.origin
          : { sessionId, period, fileName: m.fileNames[side], fingerprint: FP[m.fileNames[side].replace('.csv', '')], recordNumber: t.index + 1 },
      })
    })
  }
  return buildOutstandingFile({ sessionId, context: CONTEXT, period, outstanding: items, cleared, exportedAt: '2026-10-01T00:00:00.000Z' })
}

function itemSummary(file: OutstandingFile) {
  return file.items.map((i) => `${i.side} ${i.date} ${i.amount} ${i.description}`)
}

function september() {
  const m = month(BANK_SEP, BOOKS_SEP, { bank: 'bank-sep.csv', books: 'books-sep.csv' }, { ...DEFAULT_MATCHING, referencesShared: true })
  confirm(m, 'Receipt', 'Receipt')
  return m
}

describe('two-month reconciliation fixture', () => {
  it('September: receipts match, two cheques stay outstanding, and the bridge closes', () => {
    const m = september()
    const b = bridge(m, { bank: ['1000.00', '1300.00'], books: ['1000.00', '1050.00'] })
    expect(b.source).toEqual({ bank: { status: 'validated' }, books: { status: 'validated' } })
    expect(formatDecimal(b.actual as Decimal)).toBe('250.00')
    expect(b.complete).toBe(true)
    const file = outstanding(m, 'sep', SEP)
    expect(itemSummary(file)).toEqual(['books 2026-09-15 -50.00 Cheque 102 issued', 'books 2026-09-29 -200.00 Cheque 101 issued'])
    expect(file.cleared).toEqual([])
  })

  it('October: the carried cheque clears without its amount being counted twice', () => {
    const sepFile = readOutstandingFile(JSON.parse(JSON.stringify(outstanding(september(), 'sep', SEP))))
    const rules = { ...DEFAULT_MATCHING, referencesShared: true }
    const oct = month(BANK_OCT, BOOKS_OCT, { bank: 'bank-oct.csv', books: 'books-oct.csv' }, rules, sepFile)
    expect(checkImport(sepFile, { context: CONTEXT, period: OCT, imported: new Set(), clearedElsewhere: new Set(), current: oct.current })).toEqual({
      errors: [],
      warnings: [],
      overlaps: [],
    })

    // Opening check: 1,300.00 − 1,050.00 = 0 − (−200.00 − 50.00).
    confirm(oct, 'Cheque 101 cleared', 'Cheque 101 issued')
    confirm(oct, 'NETFLIX', 'Netflix', 0)
    confirm(oct, 'NETFLIX', 'Netflix', 0)
    const balances = { bank: ['1300.00', '1020.02'], books: ['1050.00', '1530.02'] } as Record<ReconSide, [string, string]>
    const b = bridge(oct, balances)
    // Books movement is October's rows only (480.02); the carried cheques are not in it.
    expect(formatDecimal(sum(oct.current.books.map((t) => t.amount)))).toBe('480.02')
    expect(b.source.books).toEqual({ status: 'validated' })
    expect(b.opening).toEqual({ status: 'pass' })
    expect(formatDecimal(b.actual as Decimal)).toBe('-510.00')
    expect(b.complete).toBe(true)

    // Counting the cleared cheque again in October's movement breaks the source check.
    const doubled = sum([...oct.current.books.map((t) => t.amount), d('-200.00')])
    expect(computeBridge({ ...bridgeInputs(oct, balances), sides: { ...bridgeInputs(oct, balances).sides, books: { balances: { opening: d('1050.00'), closing: d('1530.02') }, movement: doubled, invalidRows: 0 } } }).source.books.status).toBe('mismatch')

    // Cheque 102 cleared 35 days after issue, outside the 3-day window: no suggestion, so
    // it stays outstanding on both sides. The bridge still closes; that alone proves nothing.
    expect(() => confirm(oct, 'Cheque 102 cleared', 'Cheque 102 issued')).toThrow('no open suggestion')
    const stillOpen = outstanding(oct, 'oct', OCT)
    expect(itemSummary(stillOpen)).toEqual([
      'bank 2026-10-20 -50.00 Cheque 102 cleared',
      'bank 2026-10-31 -10.00 Bank charge',
      'books 2026-10-30 500.00 Receipt',
      'books 2026-09-15 -50.00 Cheque 102 issued',
    ])
    expect(stillOpen.cleared).toEqual([sepFile.items[1].lineage])
  })

  it('October with a wider window: the late cheque clears too, and only new items carry forward', () => {
    const sepFile = outstanding(september(), 'sep', SEP)
    const oct = month(BANK_OCT, BOOKS_OCT, { bank: 'bank-oct.csv', books: 'books-oct.csv' }, { ...DEFAULT_MATCHING, referencesShared: true, bankDaysAfter: 40 }, sepFile)
    confirm(oct, 'Cheque 101 cleared', 'Cheque 101 issued')
    confirm(oct, 'Cheque 102 cleared', 'Cheque 102 issued')
    confirm(oct, 'NETFLIX', 'Netflix', 0)
    confirm(oct, 'NETFLIX', 'Netflix', 0)
    const b = bridge(oct, { bank: ['1300.00', '1020.02'], books: ['1050.00', '1530.02'] })
    expect(b.complete).toBe(true)
    expect(formatDecimal(b.explained)).toBe('-510.00')
    const octFile = outstanding(oct, 'oct', OCT)
    expect(itemSummary(octFile)).toEqual(['bank 2026-10-31 -10.00 Bank charge', 'books 2026-10-30 500.00 Receipt'])
    expect(octFile.cleared.sort()).toEqual(sepFile.items.map((i) => i.lineage).sort())
    // New items take lineage from their own source row; nothing from September is carried again.
    expect(octFile.items.map((i) => i.origin.fileName)).toEqual(['bank-oct.csv', 'books-oct.csv'])

    // November: importing October's file, then September's stale one, is refused.
    const nov = { context: CONTEXT, period: { start: '2026-11-01', end: '2026-11-30' }, current: { bank: [], books: [] } }
    expect(checkImport(octFile, { ...nov, imported: new Set(), clearedElsewhere: new Set() }).errors).toEqual([])
    const stale = checkImport(sepFile, { ...nov, imported: new Set(octFile.items.map((i) => i.lineage)), clearedElsewhere: new Set(octFile.cleared) })
    expect(stale.errors).toHaveLength(2)
    expect(stale.errors[0]).toMatch(/already cleared according to a file imported earlier/)
  })

  it('an overlapping October export is flagged and its repeated cheque breaks the books check', () => {
    const sepFile = outstanding(september(), 'sep', SEP)
    const oct = month(BANK_OCT, BOOKS_OCT_OVERLAP, { bank: 'bank-oct.csv', books: 'books-oct.csv' }, DEFAULT_MATCHING, sepFile)
    const check = checkImport(sepFile, { context: CONTEXT, period: OCT, imported: new Set(), clearedElsewhere: new Set(), current: oct.current })
    expect(check.overlaps).toEqual([{ lineage: sepFile.items[1].lineage, side: 'books', current: [0] }])
    expect(isoDate(oct.current.books[0].day)).toBe('2026-09-29')
    // The repeated row is current movement too, so October's books no longer reconcile to
    // their balances: the overlap can't silently double the cheque.
    const b = bridge(oct, { bank: ['1300.00', '1020.02'], books: ['1050.00', '1530.02'] })
    expect(b.source.books.status).toBe('mismatch')
    expect(b.complete).toBe(false)
  })
})

function bridgeInputs(m: Month, balances: Record<ReconSide, [string, string]>) {
  const usedBank = new Set(m.confirmed.map((p) => p[0]))
  const usedBooks = new Set(m.confirmed.map((p) => p[1]))
  const amounts = (ts: Transaction[]) => ts.map((t) => t.amount)
  const total = (ts: Transaction[]) => sum(amounts(ts))
  return {
    sides: {
      // Movement is current-period rows only: opening items are never counted again.
      bank: { balances: { opening: d(balances.bank[0]), closing: d(balances.bank[1]) }, movement: sum(amounts(m.current.bank)), invalidRows: 0 },
      books: { balances: { opening: d(balances.books[0]), closing: d(balances.books[1]) }, movement: sum(amounts(m.current.books)), invalidRows: 0 },
    },
    openingAll: { bank: total(m.opening.bank), books: total(m.opening.books) },
    openingRemaining: {
      bank: total(m.opening.bank.filter((_, i) => !usedBank.has(m.current.bank.length + i))),
      books: total(m.opening.books.filter((_, i) => !usedBooks.has(m.current.books.length + i))),
    },
    unmatched: { bank: total(m.current.bank.filter((_, p) => !usedBank.has(p))), books: total(m.current.books.filter((_, p) => !usedBooks.has(p))) },
    confirmedDifferences: m.confirmed.map(([b, l]): Decimal => ({ units: m.pool.bank[b].amount.units - m.pool.books[l].amount.units, scale: CONTEXT.minorUnits })),
    incompleteSearch: m.candidates.incomplete !== null,
  }
}
