import { describe, expect, it } from 'vitest'
import { parseCsv } from '../engine/parse'
import type { ParsedFile } from '../engine/types'
import { isoDate } from './dates'
import { mappingIssues, normalizeSide } from './normalize'
import type { SessionContext, SideMapping } from './types'

const INR: SessionContext = { account: 'Current account', currency: 'INR', minorUnits: 2 }

function file(text: string): ParsedFile {
  const outcome = parseCsv(text, { delimiter: ',', trimHeaders: true })
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
  return outcome.file
}

const signedMapping: SideMapping = {
  delimiter: ',',
  layout: { headerRecord: 1, skipLeading: 0, skipTrailing: 0 },
  date: { column: 'date', format: 'DD/MM/YYYY', kind: 'posting' },
  amount: { kind: 'signed', column: 'amount', positiveIs: 'in' },
  amountFormat: { grouped: true, trailingMinus: true, parentheses: false },
  reference: 'ref',
  description: null,
  balance: null,
}

const splitMapping: SideMapping = {
  ...signedMapping,
  amount: { kind: 'split', inColumn: 'credit', outColumn: 'debit', unused: 'blank' },
}

function amounts(text: string, mapping: SideMapping, context = INR) {
  const result = normalizeSide('bank', file(text), mapping, context)
  return {
    valid: result.transactions.map((t) => [t.index, `${t.amount.units}/${t.amount.scale}`]),
    problems: result.problems.map((p) => [p.index, p.field, p.message]),
    zero: result.zero,
  }
}

describe('normalizeSide', () => {
  it('reads signed amounts, dates and references', () => {
    const result = normalizeSide('books', file('date,amount,ref\n05/01/2026,"1,234.5",CHQ-001\n06/01/2026,200.00-,\n'), signedMapping, INR)
    expect(result.problems).toEqual([])
    expect(result.transactions.map((t) => [isoDate(t.day), t.amount, t.reference])).toEqual([
      ['2026-01-05', { units: 123450n, scale: 2 }, 'CHQ-001'],
      ['2026-01-06', { units: -20000n, scale: 2 }, null],
    ])
  })

  it('flips the sign when positive amounts are money out', () => {
    const mapping: SideMapping = { ...signedMapping, amount: { kind: 'signed', column: 'amount', positiveIs: 'out' } }
    expect(amounts('date,amount,ref\n05/01/2026,10,\n05/01/2026,-4,\n', mapping).valid).toEqual([
      [0, '-1000/2'],
      [1, '400/2'],
    ])
  })

  it('reads separate money-in and money-out columns', () => {
    const result = amounts('date,credit,debit,ref\n05/01/2026,100.00,,\n05/01/2026,,25,\n', splitMapping)
    expect(result.valid).toEqual([
      [0, '10000/2'],
      [1, '-2500/2'],
    ])
  })

  it('makes conflicting, negative, blank and invalid amounts problems, never zero', () => {
    const result = amounts(
      'date,credit,debit,ref\n05/01/2026,100,25,\n05/01/2026,-5,,\n05/01/2026,,,\n05/01/2026,N/A,,\n05/01/2026,1.005,,\n',
      splitMapping,
    )
    expect(result.valid).toEqual([])
    expect(result.zero).toEqual([])
    expect(result.problems).toEqual([
      [0, 'amount', 'Both money in and money out hold an amount'],
      [1, 'amount', 'Money in is negative ("-5"); a reversal is not moved to the other column'],
      [2, 'amount', 'Neither money in nor money out holds an amount'],
      [3, 'amount', 'Money in: "N/A" is not a number in the chosen format'],
      [4, 'amount', 'Money in: "1.005" has more than 2 decimal places, which INR does not allow'],
    ])
  })

  it('treats a zero in the unused column as a value unless the mapping says otherwise', () => {
    const text = 'date,credit,debit,ref\n05/01/2026,100.00,0.00,\n'
    expect(amounts(text, splitMapping).problems).toEqual([[0, 'amount', 'Both money in and money out hold an amount']])
    const lenient: SideMapping = { ...splitMapping, amount: { kind: 'split', inColumn: 'credit', outColumn: 'debit', unused: 'blank-or-zero' } }
    expect(amounts(text, lenient).valid).toEqual([[0, '10000/2']])
  })

  it('keeps zero-value transactions apart from matching', () => {
    expect(amounts('date,amount,ref\n05/01/2026,0.00,\n', signedMapping)).toEqual({ valid: [], problems: [], zero: [0] })
  })

  it('accepts trailing zeros beyond the currency scale but not digits', () => {
    expect(amounts('date,amount,ref\n05/01/2026,12.500,\n', signedMapping).valid).toEqual([[0, '1250/2']])
    expect(amounts('date,amount,ref\n05/01/2026,12,\n', signedMapping, { ...INR, currency: 'JPY', minorUnits: 0 }).valid).toEqual([[0, '12/0']])
  })

  it('reports date and amount problems on the same row separately', () => {
    expect(amounts('date,amount,ref\n31/02/2026,x,\n', signedMapping).problems).toEqual([
      [0, 'date', '"31/02/2026" is not a real date'],
      [0, 'amount', '"x" is not a number in the chosen format'],
    ])
  })
})

describe('mappingIssues', () => {
  it('blocks missing columns instead of substituting another', () => {
    expect(mappingIssues(signedMapping, ['date', 'value', 'ref'])).toEqual(['Column "amount" is not in this file'])
  })

  it('requires distinct money-in and money-out columns', () => {
    const same: SideMapping = { ...splitMapping, amount: { kind: 'split', inColumn: 'x', outColumn: 'x', unused: 'blank' } }
    expect(mappingIssues(same, ['date', 'x', 'ref'])).toEqual(['Money in and money out must be different columns'])
  })
})

describe('bracketed negatives', () => {
  const bracketed: SideMapping = { ...signedMapping, amountFormat: { grouped: true, trailingMinus: false, parentheses: true } }

  it('read a bracketed signed amount as money out when positive is money in', () => {
    expect(amounts('date,amount,ref\n05/01/2026,"(1,234.50)",\n05/01/2026,(-5),\n', bracketed)).toEqual({
      valid: [[0, '-123450/2']],
      problems: [[1, 'amount', '"(-5)" is not a number in the chosen format']],
      zero: [],
    })
  })

  it('treat a bracketed value in a money-in or money-out column as a reversal', () => {
    const split: SideMapping = { ...splitMapping, amountFormat: bracketed.amountFormat }
    expect(amounts('date,credit,debit,ref\n05/01/2026,,(25.00),\n', split).problems).toEqual([
      [0, 'amount', 'Money out is negative ("(25.00)"); a reversal is not moved to the other column'],
    ])
  })
})
