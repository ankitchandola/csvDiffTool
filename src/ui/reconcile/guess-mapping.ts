import { DATE_FORMATS, type DateFormat, parseDate } from '../../reconciliation/dates'
import type { ReconSide } from '../../reconciliation/types'
import type { MappingDraft } from './mapping-draft'

type Rows = readonly Record<string, string>[]

function plain(header: string): string {
  let out = ''
  for (const ch of header.toLowerCase()) if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) out += ch
  return out
}

function hasAny(header: string, words: string[]): boolean {
  const text = plain(header)
  return words.some((word) => text.includes(word))
}

// Whole words only, for short words that hide inside others ("ref" in "Refund").
function hasWord(header: string, words: string[]): boolean {
  const parts: string[] = []
  let part = ''
  for (const ch of header.toLowerCase() + ' ') {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) part += ch
    else if (part) {
      parts.push(part)
      part = ''
    }
  }
  return parts.some((p) => words.includes(p))
}

function samples(rows: Rows, column: string): string[] {
  return rows.map((row) => (row[column] ?? '').trim()).filter((value) => value !== '')
}

// The date formats every sample fits, in the order the form lists them (day first before month first).
export function fittingDateFormats(values: string[]): DateFormat[] {
  if (values.length === 0) return []
  return DATE_FORMATS.filter((format) => values.every((value) => parseDate(value, format).ok))
}

function firstColumn(headers: string[], words: string[], skip: (header: string) => boolean = () => false): string {
  return headers.find((header) => hasAny(header, words) && !skip(header)) ?? ''
}

const DATE_WORDS = ['date']
const MONEY_IN_WORDS = ['deposit', 'moneyin', 'paidin', 'credit']
const MONEY_OUT_WORDS = ['withdrawal', 'moneyout', 'paidout', 'debit']
const REFERENCE_WORDS = ['reference', 'cheque', 'chq', 'vchno', 'voucher', 'utr', 'instrument']
const REFERENCE_SHORT = ['ref', 'refno']
const DESCRIPTION_WORDS = ['description', 'narration', 'remarks', 'particulars', 'details', 'memo']

function isBalance(header: string): boolean {
  return hasAny(header, ['balance'])
}

function endsWithMark(values: string[], mark: string): boolean {
  return values.length > 0 && values.some((value) => value.toLowerCase().endsWith(mark))
}

export interface Guess {
  fields: Partial<MappingDraft>
  // Other date formats the sampled dates also fit, such as month first when no day is past 12.
  otherDateFormats: DateFormat[]
}

// Reads the headers and the first rows to propose a mapping. Only the choices a file makes
// obvious are filled; the reviewer confirms them on the Map step. A ledger's debit is money
// into the cash account and its credit money out, the reverse of a bank statement.
export function guessMapping(side: ReconSide, headers: string[], rows: Rows): Guess {
  const guess: Partial<MappingDraft> = {}
  let otherDateFormats: DateFormat[] = []

  const dateCandidates = headers.filter((header) => hasAny(header, DATE_WORDS) && !hasAny(header, ['value', 'valuedt']))
  const dateColumn =
    [...dateCandidates, ...headers.filter((h) => hasAny(h, DATE_WORDS) && !dateCandidates.includes(h))].find((header) => fittingDateFormats(samples(rows, header)).length > 0) ?? ''
  if (dateColumn) {
    const [format, ...others] = fittingDateFormats(samples(rows, dateColumn))
    guess.dateColumn = dateColumn
    guess.dateFormat = format
    otherDateFormats = others
    if (hasAny(dateColumn, ['value'])) guess.dateKind = 'value'
    else if (hasAny(dateColumn, ['transaction', 'txn'])) guess.dateKind = 'transaction'
  }

  const first = (words: string[]) => firstColumn(headers, words, isBalance)
  const bankIn = first(MONEY_IN_WORDS)
  const bankOut = first(MONEY_OUT_WORDS)
  const [inColumn, outColumn] = side === 'bank' ? [bankIn, bankOut] : [bankOut, bankIn]
  const signed = firstColumn(headers, ['amount', 'amt'], (h) => isBalance(h) || h === bankIn || h === bankOut)
  const amountColumns: string[] = []
  if (inColumn && outColumn && inColumn !== outColumn && bankIn !== bankOut) {
    guess.amountKind = 'split'
    guess.inColumn = inColumn
    guess.outColumn = outColumn
    amountColumns.push(inColumn, outColumn)
  } else if (signed) {
    guess.amountKind = 'signed'
    guess.amountColumn = signed
    amountColumns.push(signed)
  }

  const amountValues = amountColumns.flatMap((column) => samples(rows, column))
  if (amountValues.some((value) => value.includes(','))) guess.grouped = true
  if (amountValues.some((value) => value.includes('(') && value.includes(')'))) guess.parentheses = true
  if (amountValues.some((value) => value.endsWith('-'))) guess.trailingMinus = true

  const taken = new Set([dateColumn, ...amountColumns])
  const reference = headers.find((header) => !taken.has(header) && !isBalance(header) && (hasAny(header, REFERENCE_WORDS) || hasWord(header, REFERENCE_SHORT))) ?? ''
  if (reference) guess.reference = reference
  taken.add(reference)
  const description = headers.find((header) => !taken.has(header) && !isBalance(header) && hasAny(header, DESCRIPTION_WORDS)) ?? ''
  if (description) guess.description = description
  const balance = headers.find((header) => isBalance(header) && !hasAny(header, ['opening'])) ?? ''
  if (balance) {
    guess.balance = balance
    const values = samples(rows, balance)
    if (endsWithMark(values, 'cr') || endsWithMark(values, 'dr')) guess.balanceMarks = side === 'bank' ? 'cr-positive' : 'dr-positive'
  }
  return { fields: guess, otherDateFormats }
}

// A draft nobody has filled in, or whose columns the new file no longer has.
export function needsGuess(draft: MappingDraft, headers: string[]): boolean {
  return draft.dateColumn === '' || !headers.includes(draft.dateColumn)
}
