import type { Decimal } from '../engine/decimal'
import type { Layout } from '../engine/parse'
import type { Delimiter } from '../engine/types'
import type { DateFormat } from './dates'

export type ReconSide = 'bank' | 'books'

export const RECON_SIDES: ReconSide[] = ['bank', 'books']

// Cash direction for the session's account: money in or money out.
export type Direction = 'in' | 'out'

// Bank statements label from the bank's side, so the money-in column is often headed
// "Credit"; mappings name columns by cash flow, never by debit or credit.
export type AmountMapping =
  | { kind: 'signed'; column: string; positiveIs: Direction }
  // unused: what the column a transaction doesn't use holds. 'blank' treats "0.00" there as
  // a value, so a row with an amount in both columns is a problem rather than guessed.
  | { kind: 'split'; inColumn: string; outColumn: string; unused: 'blank' | 'blank-or-zero' }

export interface AmountFormat {
  grouped: boolean
  trailingMinus: boolean
  // (1,234.50) is a negative amount.
  parentheses: boolean
}

export type DateKind = 'posting' | 'value' | 'transaction'

export interface SideMapping {
  delimiter: 'auto' | Delimiter
  layout: Layout
  date: { column: string; format: DateFormat; kind: DateKind }
  amount: AmountMapping
  amountFormat: AmountFormat
  reference: string | null
  description: string | null
  // Optional running balance after each row, checked against the opening balance.
  balance: string | null
}

// Stated by the user: the files carry no account or currency metadata to check it against.
export interface SessionContext {
  account: string
  currency: string
  // Decimal places the currency allows: 2 for INR, 0 for JPY, 3 for KWD.
  minorUnits: number
}

export interface MatchingRules {
  // Inclusive bounds on how many days the bank date may be before or after the books date.
  bankDaysBefore: number
  bankDaysAfter: number
  // References take part in matching only when both columns hold the same identifier.
  referencesShared: boolean
  referenceCaseInsensitive: boolean
}

export const DEFAULT_MATCHING: MatchingRules = {
  bankDaysBefore: 3,
  bankDaysAfter: 3,
  referencesShared: false,
  referenceCaseInsensitive: false,
}

// A valid transaction. Original values stay in the parsed source row (index); this holds
// only what matching needs.
export interface Transaction {
  side: ReconSide
  index: number
  day: number
  // Signed cash flow at the currency's scale: positive is money in.
  amount: Decimal
  // Trimmed text; null when the column is unmapped or the cell is blank.
  reference: string | null
  // Set for an opening item carried from an earlier period: which imported file and which
  // of that side's items in it. index is then the item's position, not a source row.
  opening?: { file: number; item: number }
}

export type ProblemField = 'date' | 'amount'

export interface NormalizationProblem {
  side: ReconSide
  index: number
  field: ProblemField
  message: string
}

export interface NormalizedSide {
  transactions: Transaction[]
  problems: NormalizationProblem[]
  // Valid rows with a zero amount: shown separately and never matched automatically.
  zero: number[]
}
