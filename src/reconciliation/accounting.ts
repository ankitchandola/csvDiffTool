import { addDecimal, compareDecimal, type Decimal, negateDecimal, subtractDecimal } from '../engine/decimal'
import type { ReconSide } from './types'

const ZERO: Decimal = { units: 0n, scale: 0 }

export function sum(values: Decimal[]): Decimal {
  return values.reduce(addDecimal, ZERO)
}

function isZero(d: Decimal): boolean {
  return d.units === 0n
}

// Balances in cash terms: positive is money held. Books kept on a liability basis (a
// credit card, an overdraft account) state the opposite sign; the session declares it
// so the balance is turned into cash terms once, explicitly.
export type BalanceBasis = 'cash' | 'liability'

export function cashBalance(stated: Decimal, basis: BalanceBasis): Decimal {
  return basis === 'cash' ? stated : negateDecimal(stated)
}

export interface SideBalances {
  opening: Decimal | null
  closing: Decimal | null
}

export interface SideFacts {
  balances: SideBalances
  // Sum of valid current-period movements, including zero-value rows. Never includes
  // opening items: those belong to the period they were posted in.
  movement: Decimal
  invalidRows: number
}

export type SourceCheck =
  | { status: 'validated' }
  | { status: 'missing-balances' }
  | { status: 'invalid-rows'; invalidRows: number }
  // expected is opening + movement; difference is closing − expected.
  | { status: 'mismatch'; expected: Decimal; difference: Decimal }

// Claim 1: opening balance plus current movement equals closing balance. An invalid row
// has no trustworthy amount, so it blocks validation rather than counting as zero.
export function checkSource(facts: SideFacts): SourceCheck {
  const { opening, closing } = facts.balances
  if (opening === null || closing === null) return { status: 'missing-balances' }
  if (facts.invalidRows > 0) return { status: 'invalid-rows', invalidRows: facts.invalidRows }
  const expected = addDecimal(opening, facts.movement)
  const difference = subtractDecimal(closing, expected)
  return isZero(difference) ? { status: 'validated' } : { status: 'mismatch', expected, difference }
}

export interface RunningBalanceBreak {
  // 1-based position among the rows checked, in source order.
  row: number
  expected: Decimal
  found: Decimal
}

export type RunningBalanceCheck =
  | { status: 'consistent' }
  | { status: 'break'; first: RunningBalanceBreak }
  // A row without a valid amount or balance stops the check: nothing after it can be trusted.
  | { status: 'unreadable'; row: number }

// Walks rows in source order: each balance must equal the previous one plus the row's
// signed amount. The first break also exposes missing or reordered rows.
export function checkRunningBalance(opening: Decimal, rows: { amount: Decimal | null; balance: Decimal | null }[]): RunningBalanceCheck {
  let previous = opening
  for (const [i, { amount, balance }] of rows.entries()) {
    if (amount === null || balance === null) return { status: 'unreadable', row: i + 1 }
    const expected = addDecimal(previous, amount)
    if (compareDecimal(expected, balance) !== 0) return { status: 'break', first: { row: i + 1, expected, found: balance } }
    previous = balance
  }
  return { status: 'consistent' }
}

export interface BridgeInput {
  sides: Record<ReconSide, SideFacts>
  // Imported opening items, all of them and those not consumed by a confirmed match.
  openingAll: Record<ReconSide, Decimal[]>
  openingRemaining: Record<ReconSide, Decimal[]>
  // Valid current movements not in a confirmed match.
  unmatched: Record<ReconSide, Decimal[]>
  // Per confirmed group: its bank total minus its books total, opening items included at
  // their carried amount. Zero for an exact match; otherwise a variance.
  confirmedDifferences: Decimal[]
  incompleteSearch: boolean
}

export interface Bridge {
  source: Record<ReconSide, SourceCheck>
  // B_open − L_open must equal ΣO_B − ΣO_L exactly; an explanation can't stand in for it.
  opening: { status: 'pass' } | { status: 'missing-balances' } | { status: 'uncovered'; difference: Decimal; covered: Decimal }
  // B_close − L_close, when both closing balances are known.
  actual: Decimal | null
  // The right-hand side of the bridge from items and variances.
  explained: Decimal
  // actual − explained; zero whenever the inputs are consistent.
  unexplained: Decimal | null
  complete: boolean
  // Why the bridge is not complete, in plain words.
  gaps: string[]
}

const SIDE_NAMES: Record<ReconSide, string> = { bank: 'Bank', books: 'Books' }

export function computeBridge(input: BridgeInput): Bridge {
  const { sides } = input
  const source = { bank: checkSource(sides.bank), books: checkSource(sides.books) }
  const gaps: string[] = []
  for (const side of ['bank', 'books'] as const) {
    const check = source[side]
    if (check.status === 'missing-balances') gaps.push(`${SIDE_NAMES[side]}: opening and closing balances are needed`)
    if (check.status === 'invalid-rows') gaps.push(`${SIDE_NAMES[side]}: ${check.invalidRows} invalid row${check.invalidRows === 1 ? '' : 's'} have no trustworthy amount`)
    if (check.status === 'mismatch') gaps.push(`${SIDE_NAMES[side]}: opening plus movements does not equal the closing balance`)
  }

  const openingBank = sides.bank.balances.opening
  const openingBooks = sides.books.balances.opening
  const covered = subtractDecimal(sum(input.openingAll.bank), sum(input.openingAll.books))
  let opening: Bridge['opening']
  if (openingBank === null || openingBooks === null) {
    opening = { status: 'missing-balances' }
  } else {
    const difference = subtractDecimal(openingBank, openingBooks)
    opening = compareDecimal(difference, covered) === 0 ? { status: 'pass' } : { status: 'uncovered', difference, covered }
    if (opening.status === 'uncovered') gaps.push('The opening difference is not fully covered by opening items')
  }
  if (input.incompleteSearch) gaps.push('The candidate search is incomplete')

  const explained = addDecimal(
    addDecimal(subtractDecimal(sum(input.openingRemaining.bank), sum(input.openingRemaining.books)), subtractDecimal(sum(input.unmatched.bank), sum(input.unmatched.books))),
    sum(input.confirmedDifferences),
  )
  const closingBank = sides.bank.balances.closing
  const closingBooks = sides.books.balances.closing
  const actual = closingBank !== null && closingBooks !== null ? subtractDecimal(closingBank, closingBooks) : null
  const unexplained = actual === null ? null : subtractDecimal(actual, explained)
  if (unexplained !== null && !isZero(unexplained) && gaps.length === 0) gaps.push('The bridge does not explain the closing difference')

  const complete = source.bank.status === 'validated' && source.books.status === 'validated' && opening.status === 'pass' && !input.incompleteSearch && unexplained !== null && isZero(unexplained)
  return { source, opening, actual, explained, unexplained, complete, gaps }
}
