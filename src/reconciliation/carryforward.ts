import { type Decimal, formatDecimal, parseDecimal, toScale } from '../engine/decimal'
import { isoDate, parseDate } from './dates'
import type { Direction, ReconSide, SessionContext, Transaction } from './types'

export const OUTSTANDING_FORMAT = 'reconciliation-outstanding'
export const OUTSTANDING_VERSION = 1

export class CarryForwardError extends Error {}

export interface Period {
  // Inclusive calendar dates, YYYY-MM-DD.
  start: string
  end: string
}

// Where an outstanding item first appeared. It keeps this while it is carried, month
// after month, until a confirmed match consumes it.
export interface Provenance {
  sessionId: string
  period: Period
  fileName: string
  fingerprint: string
  recordNumber: number
}

export interface OutstandingItem {
  // Stable identity across sessions: set when the item is first left outstanding and
  // never changed while it is carried.
  lineage: string
  side: ReconSide
  // Original posting date; it is never moved into the new period.
  date: string
  // Exact signed cash flow, as decimal text.
  amount: string
  direction: Direction
  reference: string | null
  description: string | null
  origin: Provenance
}

export interface OutstandingFile {
  format: typeof OUTSTANDING_FORMAT
  version: typeof OUTSTANDING_VERSION
  exportedAt: string
  sessionId: string
  account: string
  currency: string
  minorUnits: number
  period: Period
  items: OutstandingItem[]
  // Lineages this session consumed: a later import that still lists one of them as
  // outstanding is refused.
  cleared: string[]
}

export function lineageFor(origin: Provenance, side: ReconSide): string {
  return `${side}|${origin.fingerprint}|${origin.recordNumber}`
}

function fail(message: string): never {
  throw new CarryForwardError(message)
}

function validDate(text: unknown, where: string): string {
  if (typeof text !== 'string' || !parseDate(text, 'YYYY-MM-DD').ok) fail(`${where} must be a YYYY-MM-DD date`)
  return text
}

function readPeriod(value: unknown, where: string): Period {
  const p = (value ?? {}) as Record<string, unknown>
  const period = { start: validDate(p.start, `${where}.start`), end: validDate(p.end, `${where}.end`) }
  if (period.start > period.end) fail(`${where} ends before it starts`)
  return period
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string') fail(`${where} must be text`)
  return value
}

function optionalText(value: unknown, where: string): string | null {
  return value === null ? null : text(value, where)
}

export function readOutstandingFile(value: unknown): OutstandingFile {
  const root = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  if (root.format !== OUTSTANDING_FORMAT) fail('This is not an outstanding-items file')
  if (root.version !== OUTSTANDING_VERSION) fail(`Outstanding-items version ${String(root.version)} is not supported`)
  if (!Array.isArray(root.items) || !Array.isArray(root.cleared)) fail('items and cleared must be lists')
  const minorUnits = root.minorUnits
  if (typeof minorUnits !== 'number' || !Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 4) fail('minorUnits must be 0 to 4')
  const items = root.items.map((raw, i): OutstandingItem => {
    const where = `items[${i}]`
    const item = (raw ?? {}) as Record<string, unknown>
    const amountText = text(item.amount, `${where}.amount`)
    const amount = parseDecimal(amountText)
    if (amount === null || toScale(amount, minorUnits) === null) fail(`${where}.amount must be exact decimal text with at most ${minorUnits} decimal places`)
    if (amount.units === 0n) fail(`${where}.amount is zero`)
    const direction: Direction = amount.units > 0n ? 'in' : 'out'
    if (item.direction !== direction) fail(`${where}.direction does not match the amount's sign`)
    const side = item.side
    if (side !== 'bank' && side !== 'books') fail(`${where}.side must be bank or books`)
    const origin = (item.origin ?? {}) as Record<string, unknown>
    const recordNumber = origin.recordNumber
    if (typeof recordNumber !== 'number' || !Number.isInteger(recordNumber) || recordNumber < 1) fail(`${where}.origin.recordNumber must be a whole number`)
    return {
      lineage: text(item.lineage, `${where}.lineage`),
      side,
      date: validDate(item.date, `${where}.date`),
      amount: amountText,
      direction,
      reference: optionalText(item.reference, `${where}.reference`),
      description: optionalText(item.description, `${where}.description`),
      origin: {
        sessionId: text(origin.sessionId, `${where}.origin.sessionId`),
        period: readPeriod(origin.period, `${where}.origin.period`),
        fileName: text(origin.fileName, `${where}.origin.fileName`),
        fingerprint: text(origin.fingerprint, `${where}.origin.fingerprint`),
        recordNumber,
      },
    }
  })
  return {
    format: OUTSTANDING_FORMAT,
    version: OUTSTANDING_VERSION,
    exportedAt: text(root.exportedAt, 'exportedAt'),
    sessionId: text(root.sessionId, 'sessionId'),
    account: text(root.account, 'account'),
    currency: text(root.currency, 'currency'),
    minorUnits,
    period: readPeriod(root.period, 'period'),
    items,
    cleared: root.cleared.map((c, i) => text(c, `cleared[${i}]`)),
  }
}

export interface ImportTarget {
  context: SessionContext
  period: Period
  // Lineages already imported into this session as opening items.
  imported: Set<string>
  // Lineages that files already imported into this session list as cleared.
  clearedElsewhere: Set<string>
  // The session's current movements, for overlap checks.
  current: Record<ReconSide, Transaction[]>
}

export interface PotentialOverlap {
  lineage: string
  side: ReconSide
  // Positions in the current transaction list with the same date, amount and reference.
  current: number[]
}

export interface ImportCheck {
  // Refusals: the file can't be imported until they are resolved.
  errors: string[]
  // Accepted with review: the reviewer must look at these before relying on the bridge.
  warnings: string[]
  overlaps: PotentialOverlap[]
}

function dayBefore(iso: string): string {
  const outcome = parseDate(iso, 'YYYY-MM-DD')
  return outcome.ok ? isoDate(outcome.day - 1) : iso
}

// Checks an outstanding-items file against the session it is imported into. Errors
// refuse it whole; nothing is half-imported.
export function checkImport(file: OutstandingFile, target: ImportTarget): ImportCheck {
  const errors: string[] = []
  const warnings: string[] = []
  const { context, period } = target
  if (file.currency !== context.currency || file.minorUnits !== context.minorUnits) {
    errors.push(`The file is for ${file.currency} with ${file.minorUnits} decimal places; this session is ${context.currency} with ${context.minorUnits}`)
  }
  if (file.account !== context.account) errors.push(`The file is for account “${file.account}”; this session is “${context.account}”`)
  if (file.period.end >= period.start) errors.push(`The file's period ends ${file.period.end}, not before this session's period starts (${period.start})`)
  else if (file.period.end !== dayBefore(period.start)) warnings.push(`The periods are not consecutive: the file ends ${file.period.end} and this session starts ${period.start}`)

  const seen = new Set<string>()
  const cleared = new Set(file.cleared)
  for (const item of file.items) {
    if (seen.has(item.lineage)) errors.push(`Item ${item.lineage} appears more than once in the file`)
    seen.add(item.lineage)
    if (target.imported.has(item.lineage)) errors.push(`Item ${item.lineage} is already imported into this session`)
    if (target.clearedElsewhere.has(item.lineage)) errors.push(`Item ${item.lineage} was already cleared according to a file imported earlier; it can't be outstanding again`)
    if (cleared.has(item.lineage)) errors.push(`Item ${item.lineage} is listed as cleared and as outstanding`)
    if (item.date >= period.start) errors.push(`Item ${item.lineage} is dated ${item.date}, inside or after this session's period`)
  }
  for (const lineage of file.cleared) {
    if (target.imported.has(lineage)) errors.push(`The file says ${lineage} was cleared, but it is imported here as outstanding`)
  }

  // An export that overlaps the previous period repeats transactions that were already
  // outstanding. Equal content doesn't prove it's the same transaction, so this asks for
  // review rather than discarding either.
  const overlaps: PotentialOverlap[] = []
  for (const item of file.items) {
    const amount = parseDecimal(item.amount) as Decimal
    const day = (parseDate(item.date, 'YYYY-MM-DD') as { ok: true; day: number }).day
    const scale = context.minorUnits
    const units = (toScale(amount, scale) as Decimal).units
    const matches = target.current[item.side]
      .map((t, position) => ({ t, position }))
      .filter(({ t }) => t.day === day && t.amount.units === units && (t.reference ?? null) === (item.reference ?? null))
      .map(({ position }) => position)
    if (matches.length > 0) overlaps.push({ lineage: item.lineage, side: item.side, current: matches })
  }
  if (overlaps.length > 0) warnings.push(`${overlaps.length} carried item${overlaps.length === 1 ? '' : 's'} may also be in this period's files (an overlapping export); review before relying on the bridge`)
  return { errors, warnings, overlaps }
}

// Opening items join their side's pool for matching. Index is the item's position in
// the file, so keys stay stable for the same file.
export function openingTransactions(file: OutstandingFile, side: ReconSide, minorUnits: number): Transaction[] {
  return file.items
    .filter((item) => item.side === side)
    .map((item, index) => ({
      side,
      index,
      day: (parseDate(item.date, 'YYYY-MM-DD') as { ok: true; day: number }).day,
      amount: toScale(parseDecimal(item.amount) as Decimal, minorUnits) as Decimal,
      reference: item.reference,
    }))
}

export interface OutstandingSource {
  transaction: Transaction
  description: string | null
  // Set for a carried opening item; null for one first left outstanding in this session.
  carried: OutstandingItem | null
  provenance: Provenance
}

export function buildOutstandingFile(args: {
  sessionId: string
  context: SessionContext
  period: Period
  outstanding: OutstandingSource[]
  cleared: string[]
  exportedAt: string
}): OutstandingFile {
  const items = args.outstanding.map(({ transaction: t, description, carried, provenance }): OutstandingItem =>
    carried ?? {
      lineage: lineageFor(provenance, t.side),
      side: t.side,
      date: isoDate(t.day),
      amount: formatDecimal(t.amount),
      direction: t.amount.units > 0n ? 'in' : 'out',
      reference: t.reference,
      description,
      origin: provenance,
    },
  )
  return {
    format: OUTSTANDING_FORMAT,
    version: OUTSTANDING_VERSION,
    exportedAt: args.exportedAt,
    sessionId: args.sessionId,
    account: args.context.account,
    currency: args.context.currency,
    minorUnits: args.context.minorUnits,
    period: args.period,
    items,
    cleared: args.cleared,
  }
}
