import { type Decimal, negateDecimal, parseDecimal, toScale } from '../engine/decimal'
import type { ParsedFile, Row } from '../engine/types'
import { parseDate } from './dates'
import type { AmountMapping, Direction, NormalizationProblem, NormalizedSide, ReconSide, SessionContext, SideMapping, Transaction } from './types'

export function mappedColumns(mapping: SideMapping): string[] {
  const { amount } = mapping
  const amountColumns = amount.kind === 'signed' ? [amount.column] : [amount.inColumn, amount.outColumn]
  return [mapping.date.column, ...amountColumns, mapping.reference, mapping.description].filter((c): c is string => c !== null)
}

// A missing column blocks the mapping; it is never replaced by another column.
export function mappingIssues(mapping: SideMapping, headers: string[]): string[] {
  const issues: string[] = []
  const known = new Set(headers)
  for (const column of mappedColumns(mapping)) {
    if (column === '') continue
    if (!known.has(column)) issues.push(`Column "${column}" is not in this file`)
  }
  if (mapping.date.column === '') issues.push('Choose the date column')
  const { amount } = mapping
  if (amount.kind === 'signed' && amount.column === '') issues.push('Choose the amount column')
  if (amount.kind === 'split') {
    if (amount.inColumn === '' || amount.outColumn === '') issues.push('Choose both the money-in and money-out columns')
    else if (amount.inColumn === amount.outColumn) issues.push('Money in and money out must be different columns')
  }
  return issues
}

export function contextIssues({ currency, minorUnits }: SessionContext): string[] {
  const issues: string[] = []
  if (currency.trim() === '') issues.push('Enter the currency')
  if (!Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 4) issues.push('Decimal places must be a whole number from 0 to 4')
  return issues
}

type AmountOutcome = { ok: true; amount: Decimal } | { ok: false; message: string }

function readAmount(text: string, mapping: SideMapping, context: SessionContext): AmountOutcome {
  const value = parseDecimal(text, mapping.amountFormat)
  if (value === null) return { ok: false, message: `"${text}" is not a number in the chosen format` }
  const scaled = toScale(value, context.minorUnits)
  if (scaled === null) {
    return { ok: false, message: `"${text}" has more than ${context.minorUnits} decimal place${context.minorUnits === 1 ? '' : 's'}, which ${context.currency} does not allow` }
  }
  return { ok: true, amount: scaled }
}

function signed(amount: Decimal, direction: Direction): Decimal {
  return direction === 'in' ? amount : negateDecimal(amount)
}

function cashFlow(row: Row, amount: AmountMapping, mapping: SideMapping, context: SessionContext): AmountOutcome {
  if (amount.kind === 'signed') {
    const text = row[amount.column].trim()
    if (text === '') return { ok: false, message: 'The amount is empty' }
    const read = readAmount(text, mapping, context)
    if (!read.ok) return read
    return { ok: true, amount: amount.positiveIs === 'in' ? read.amount : negateDecimal(read.amount) }
  }
  const sides: [Direction, string][] = [
    ['in', row[amount.inColumn].trim()],
    ['out', row[amount.outColumn].trim()],
  ]
  const used: [Direction, Decimal][] = []
  for (const [direction, text] of sides) {
    if (text === '') continue
    const read = readAmount(text, mapping, context)
    if (!read.ok) return { ok: false, message: `Money ${direction}: ${read.message}` }
    if (read.amount.units < 0n) {
      return { ok: false, message: `Money ${direction} is negative ("${text}"); a reversal is not moved to the other column` }
    }
    if (amount.unused === 'blank-or-zero' && read.amount.units === 0n) continue
    used.push([direction, read.amount])
  }
  if (used.length === 2) return { ok: false, message: 'Both money in and money out hold an amount' }
  if (used.length === 1) return { ok: true, amount: signed(used[0][1], used[0][0]) }
  const allBlank = sides.every(([, text]) => text === '')
  if (allBlank) return { ok: false, message: 'Neither money in nor money out holds an amount' }
  return { ok: true, amount: { units: 0n, scale: context.minorUnits } }
}

export function normalizeSide(
  side: ReconSide,
  file: ParsedFile,
  mapping: SideMapping,
  context: SessionContext,
): NormalizedSide {
  const transactions: Transaction[] = []
  const problems: NormalizationProblem[] = []
  const zero: number[] = []
  file.rows.forEach((row, index) => {
    const date = parseDate(row[mapping.date.column], mapping.date.format)
    const amount = cashFlow(row, mapping.amount, mapping, context)
    if (!date.ok) problems.push({ side, index, field: 'date', message: date.message })
    if (!amount.ok) problems.push({ side, index, field: 'amount', message: amount.message })
    if (!date.ok || !amount.ok) return
    if (amount.amount.units === 0n) {
      zero.push(index)
      return
    }
    const reference = mapping.reference === null ? '' : row[mapping.reference].trim()
    transactions.push({ side, index, day: date.day, amount: amount.amount, reference: reference === '' ? null : reference })
  })
  return { transactions, problems, zero }
}
