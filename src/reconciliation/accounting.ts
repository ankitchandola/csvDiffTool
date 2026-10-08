import { addDecimal, compareDecimal, type Decimal, formatDecimal, negateDecimal, subtractDecimal } from '../engine/decimal'
import { SIDE_LABELS } from './location'
import { RECON_SIDES, type ReconSide } from './types'

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

// What the check found, to follow "running balance".
export function runningText(check: RunningBalanceCheck): string {
  if (check.status === 'consistent') return 'consistent with every record'
  if (check.status === 'break') return `breaks at record ${check.first.row}: expected ${formatDecimal(check.first.expected)}, found ${formatDecimal(check.first.found)}`
  return `can't be checked past record ${check.row}`
}

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
  // Totals of imported opening items: all of them, and those not consumed by a confirmed match.
  openingAll: Record<ReconSide, Decimal>
  openingRemaining: Record<ReconSide, Decimal>
  // Total of valid current movements not in a confirmed match.
  unmatched: Record<ReconSide, Decimal>
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

// Why a side's balances don't validate, in plain words; null once they do.
export function sourceGap(side: ReconSide, check: SourceCheck): string | null {
  if (check.status === 'missing-balances') return `${SIDE_LABELS[side]}: opening and closing balances are needed`
  if (check.status === 'invalid-rows') return `${SIDE_LABELS[side]}: ${check.invalidRows} invalid ${check.invalidRows === 1 ? 'record has' : 'records have'} no trustworthy amount`
  if (check.status === 'mismatch') return `${SIDE_LABELS[side]}: opening plus movements does not equal the closing balance`
  return null
}

export function computeBridge(input: BridgeInput): Bridge {
  const { sides } = input
  const source = { bank: checkSource(sides.bank), books: checkSource(sides.books) }
  const gaps = RECON_SIDES.map((side) => sourceGap(side, source[side])).filter((gap) => gap !== null)

  const openingBank = sides.bank.balances.opening
  const openingBooks = sides.books.balances.opening
  const covered = subtractDecimal(input.openingAll.bank, input.openingAll.books)
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
    addDecimal(subtractDecimal(input.openingRemaining.bank, input.openingRemaining.books), subtractDecimal(input.unmatched.bank, input.unmatched.books)),
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
