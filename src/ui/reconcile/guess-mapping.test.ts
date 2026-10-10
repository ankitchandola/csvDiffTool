import { describe, expect, it } from 'vitest'
import { fittingDateFormats, guessMapping, needsGuess } from './guess-mapping'
import { emptyDraft } from './mapping-draft'

const records = (headers: string[], rows: string[][]) => rows.map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ''])))

describe('guessMapping', () => {
  it('reads an ICICI-style statement: separate columns, lakh grouping, day-first dates', () => {
    const headers = ['S No.', 'Value Date', 'Transaction Date', 'Cheque Number', 'Transaction Remarks', 'Withdrawal Amount (INR )', 'Deposit Amount (INR )', 'Balance (INR )']
    const rows = [['1', '01/09/2026', '01/09/2026', '', 'NEFT-RAJ', '', '1,25,000.00', '3,75,000.00']]
    expect(guessMapping('bank', headers, records(headers, rows)).fields).toMatchObject({
      dateColumn: 'Transaction Date',
      dateFormat: 'DD/MM/YYYY',
      dateKind: 'transaction',
      amountKind: 'split',
      inColumn: 'Deposit Amount (INR )',
      outColumn: 'Withdrawal Amount (INR )',
      grouped: true,
      reference: 'Cheque Number',
      description: 'Transaction Remarks',
      balance: 'Balance (INR )',
    })
  })

  it("treats a ledger's debit as money in and marks balances Cr for a bank", () => {
    const headers = ['Date', 'Particulars', 'Vch Type', 'Vch No.', 'Debit', 'Credit']
    const rows = [
      ['', 'Opening Balance', '', '', '2,50,000.00', ''],
      ['1-Sep-26', 'Raj', 'Receipt', '101', '1,25,000.00', ''],
    ]
    expect(guessMapping('books', headers, records(headers, rows)).fields).toMatchObject({ dateFormat: 'DD-Mon-YY', inColumn: 'Debit', outColumn: 'Credit', reference: 'Vch No.', description: 'Particulars' })
    expect(guessMapping('bank', ['Txn Date', 'Debit', 'Credit', 'Balance'], records(['Txn Date', 'Debit', 'Credit', 'Balance'], [['1 Sep 2026', ' ', '1,000.00', '5,00,000.00 Cr']])).fields).toMatchObject({
      dateFormat: 'DD Mon YYYY',
      inColumn: 'Credit',
      outColumn: 'Debit',
      balanceMarks: 'cr-positive',
    })
  })

  it('reads one signed amount column and leaves out what the file does not show', () => {
    const guess = guessMapping('books', ['Date', 'Transaction Details', 'Reference#', 'Amount'], records(['Date', 'Transaction Details', 'Reference#', 'Amount'], [['2026-09-01', 'Payment received', 'INV-1', '(2,36,000.00)']])).fields
    expect(guess).toMatchObject({ dateFormat: 'YYYY-MM-DD', amountKind: 'signed', amountColumn: 'Amount', parentheses: true, grouped: true, reference: 'Reference#', description: 'Transaction Details' })
    expect(guess.balance).toBeUndefined()
    expect(guessMapping('bank', ['Foo', 'Bar'], records(['Foo', 'Bar'], [['a', 'b']]))).toEqual({ fields: {}, otherDateFormats: [] })
  })

  it('does not pick a date column whose values are not dates', () => {
    expect(guessMapping('bank', ['Date'], records(['Date'], [['soon']])).fields.dateColumn).toBeUndefined()
  })

  it('names the other date formats when no sampled day is past 12', () => {
    const headers = ['Date', 'Amount']
    expect(guessMapping('bank', headers, records(headers, [['01/09/2026', '5']])).otherDateFormats).toEqual(['MM/DD/YYYY'])
    expect(guessMapping('bank', headers, records(headers, [['01/09/2026', '5'], ['13/09/2026', '5']])).otherDateFormats).toEqual([])
  })

  it('takes "ref" only as a whole word, not inside "Refund"', () => {
    const headers = ['Date', 'Refund Amount', 'Ref No.', 'Amount']
    expect(guessMapping('bank', headers, records(headers, [['2026-09-01', '', 'R1', '5']])).fields.reference).toBe('Ref No.')
    expect(guessMapping('bank', ['Date', 'Refund Note', 'Amount'], records(['Date', 'Refund Note', 'Amount'], [['2026-09-01', '', '5']])).fields.reference).toBeUndefined()
  })
})

describe('fittingDateFormats', () => {
  it('lists every format all values fit, day first before month first', () => {
    expect(fittingDateFormats(['01/09/2026', '02/09/2026'])).toEqual(['DD/MM/YYYY', 'MM/DD/YYYY'])
    expect(fittingDateFormats(['13/09/2026'])).toEqual(['DD/MM/YYYY'])
    expect(fittingDateFormats([])).toEqual([])
  })
})

describe('needsGuess', () => {
  it('is true for an empty draft or a column the new file lacks', () => {
    expect(needsGuess(emptyDraft(), ['Date'])).toBe(true)
    expect(needsGuess({ ...emptyDraft(), dateColumn: 'Date' }, ['Date'])).toBe(false)
    expect(needsGuess({ ...emptyDraft(), dateColumn: 'Date' }, ['Other'])).toBe(true)
  })
})
