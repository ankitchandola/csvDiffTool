import { parseDecimal } from '../engine/decimal'
import { layoutIssues } from '../engine/parse'
import { DATE_FORMATS, type DateFormat, parseDate } from './dates'
import { applyToState, type DecisionEvent, emptyState, parseTxnKey, type RuleException, structuralCheck } from './decisions'
import { contextIssues } from './normalize'
import type { Direction, MatchingRules, ReconSide, SessionContext, SideMapping } from './types'

export const SESSION_FORMAT = 'reconciliation-session'
export const SESSION_VERSION = 1

export class SessionError extends Error {}

export interface SourceDescriptor {
  fileName: string
  // SHA-256 of the file's bytes, hex.
  fingerprint: string
  // The worksheet read, for an .xlsx.
  sheet: string | null
  recordCount: number
}

// A transaction as it was when a decision was made, so a backup shows what was
// decided even before the source files are loaded again. Amounts are exact decimal text.
export interface TransactionSnapshot {
  key: string
  date: string
  amount: string
  direction: Direction
  reference: string | null
  description: string | null
}

// Financial records and decisions: unlike a profile, this holds data from the files.
export interface SessionFile {
  format: typeof SESSION_FORMAT
  version: typeof SESSION_VERSION
  // Random, set when the session starts: tells one session from another in browser storage.
  id: string
  savedAt: string
  // Advances with every decision and configuration change.
  revision: number
  context: SessionContext
  mappings: Record<ReconSide, SideMapping>
  rules: MatchingRules
  sources: Record<ReconSide, SourceDescriptor>
  events: DecisionEvent[]
  snapshots: TransactionSnapshot[]
}

type Json = Record<string, unknown>

function fail(message: string): never {
  throw new SessionError(message)
}

function object(value: unknown, where: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${where} must be an object`)
  return value as Json
}

function string(value: unknown, where: string): string {
  if (typeof value !== 'string') fail(`${where} must be text`)
  return value
}

function optionalString(value: unknown, where: string): string | null {
  return value === null ? null : string(value, where)
}

function integer(value: unknown, where: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) fail(`${where} must be a whole number of at least ${min}`)
  return value
}

function boolean(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') fail(`${where} must be true or false`)
  return value
}

function oneOf<T extends string>(value: unknown, options: readonly T[], where: string): T {
  if (!options.includes(value as T)) fail(`${where} must be one of ${options.join(', ')}`)
  return value as T
}

function readMapping(value: unknown, where: string): SideMapping {
  const m = object(value, where)
  const layout = object(m.layout, `${where}.layout`)
  const parsedLayout = { headerRecord: integer(layout.headerRecord, `${where}.layout.headerRecord`, 1), skipTrailing: integer(layout.skipTrailing, `${where}.layout.skipTrailing`, 0) }
  if (layoutIssues(parsedLayout).length > 0) fail(`${where}.layout is invalid`)
  const date = object(m.date, `${where}.date`)
  const amount = object(m.amount, `${where}.amount`)
  const format = object(m.amountFormat, `${where}.amountFormat`)
  const kind = oneOf(amount.kind, ['signed', 'split'] as const, `${where}.amount.kind`)
  return {
    delimiter: oneOf(m.delimiter, ['auto', ',', ';', '\t'] as const, `${where}.delimiter`),
    layout: parsedLayout,
    date: {
      column: string(date.column, `${where}.date.column`),
      format: oneOf<DateFormat>(date.format, DATE_FORMATS, `${where}.date.format`),
      kind: oneOf(date.kind, ['posting', 'value', 'transaction'] as const, `${where}.date.kind`),
    },
    amount:
      kind === 'signed'
        ? { kind, column: string(amount.column, `${where}.amount.column`), positiveIs: oneOf(amount.positiveIs, ['in', 'out'] as const, `${where}.amount.positiveIs`) }
        : {
            kind,
            inColumn: string(amount.inColumn, `${where}.amount.inColumn`),
            outColumn: string(amount.outColumn, `${where}.amount.outColumn`),
            unused: oneOf(amount.unused, ['blank', 'blank-or-zero'] as const, `${where}.amount.unused`),
          },
    amountFormat: {
      grouped: boolean(format.grouped, `${where}.amountFormat.grouped`),
      trailingMinus: boolean(format.trailingMinus, `${where}.amountFormat.trailingMinus`),
      parentheses: boolean(format.parentheses, `${where}.amountFormat.parentheses`),
    },
    reference: optionalString(m.reference, `${where}.reference`),
    description: optionalString(m.description, `${where}.description`),
  }
}

function readSource(value: unknown, where: string): SourceDescriptor {
  const s = object(value, where)
  const fingerprint = string(s.fingerprint, `${where}.fingerprint`)
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) fail(`${where}.fingerprint must be a SHA-256 hex digest`)
  return { fileName: string(s.fileName, `${where}.fileName`), fingerprint, sheet: optionalString(s.sheet, `${where}.sheet`), recordCount: integer(s.recordCount, `${where}.recordCount`, 0) }
}

function readEvent(value: unknown, index: number): DecisionEvent {
  const where = `events[${index}]`
  const e = object(value, where)
  const seq = integer(e.seq, `${where}.seq`, 1)
  if (seq !== index + 1) fail(`${where}.seq must be ${index + 1}: the history must be complete and in order`)
  const action = oneOf(e.action, ['confirm', 'reject', 'restore', 'unmatch'] as const, `${where}.action`)
  const bank = string(e.bank, `${where}.bank`)
  const books = string(e.books, `${where}.books`)
  if (parseTxnKey(bank)?.side !== 'bank') fail(`${where}.bank is not a bank transaction key`)
  if (parseTxnKey(books)?.side !== 'books') fail(`${where}.books is not a books transaction key`)
  const at = string(e.at, `${where}.at`)
  if (Number.isNaN(Date.parse(at))) fail(`${where}.at must be a timestamp`)
  const event: DecisionEvent = { seq, at, action, bank, books }
  if (action === 'confirm') {
    event.origin = oneOf(e.origin, ['suggested', 'manual', 'set'] as const, `${where}.origin`)
    if (e.exceptions !== undefined) {
      if (!Array.isArray(e.exceptions)) fail(`${where}.exceptions must be a list`)
      event.exceptions = e.exceptions.map((x, i) => oneOf<RuleException>(x, ['amount', 'date', 'reference'], `${where}.exceptions[${i}]`))
    }
    if (e.reason !== undefined) event.reason = string(e.reason, `${where}.reason`)
    if ((event.exceptions?.length ?? 0) > 0 && !event.reason?.trim()) fail(`${where} breaks rules without a reason`)
  }
  return event
}

function readSnapshot(value: unknown, index: number): TransactionSnapshot {
  const where = `snapshots[${index}]`
  const s = object(value, where)
  const key = string(s.key, `${where}.key`)
  if (!parseTxnKey(key)) fail(`${where}.key is not a transaction key`)
  const date = string(s.date, `${where}.date`)
  if (!parseDate(date, 'YYYY-MM-DD').ok) fail(`${where}.date must be a YYYY-MM-DD date`)
  const amount = string(s.amount, `${where}.amount`)
  if (parseDecimal(amount) === null) fail(`${where}.amount must be exact decimal text`)
  return {
    key,
    date,
    amount,
    direction: oneOf(s.direction, ['in', 'out'] as const, `${where}.direction`),
    reference: optionalString(s.reference, `${where}.reference`),
    description: optionalString(s.description, `${where}.description`),
  }
}

// Validates everything before anything is used: an import either loads whole or not at all.
export function readSession(value: unknown): SessionFile {
  const root = object(value, 'The session')
  if (root.format !== SESSION_FORMAT) fail('This is not a reconciliation session file')
  if (root.version !== SESSION_VERSION) fail(`Session version ${String(root.version)} is not supported; this app reads version ${SESSION_VERSION}`)
  const contextJson = object(root.context, 'context')
  const context: SessionContext = {
    account: string(contextJson.account, 'context.account'),
    currency: string(contextJson.currency, 'context.currency'),
    minorUnits: integer(contextJson.minorUnits, 'context.minorUnits', 0),
  }
  const issues = contextIssues(context)
  if (issues.length > 0) fail(`context: ${issues.join('; ')}`)
  const mappings = object(root.mappings, 'mappings')
  const sources = object(root.sources, 'sources')
  const rules = object(root.rules, 'rules')
  if (!Array.isArray(root.events)) fail('events must be a list')
  if (!Array.isArray(root.snapshots)) fail('snapshots must be a list')
  const events = root.events.map(readEvent)
  const state = emptyState()
  for (const event of events) {
    const verdict = structuralCheck(state, event)
    if (!verdict.ok) fail(`events[${event.seq - 1}] contradicts the history before it: ${verdict.reason}`)
    applyToState(state, event)
  }
  const savedAt = string(root.savedAt, 'savedAt')
  if (Number.isNaN(Date.parse(savedAt))) fail('savedAt must be a timestamp')
  return {
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    id: string(root.id, 'id'),
    savedAt,
    revision: integer(root.revision, 'revision', 0),
    context,
    mappings: { bank: readMapping(mappings.bank, 'mappings.bank'), books: readMapping(mappings.books, 'mappings.books') },
    rules: {
      bankDaysBefore: integer(rules.bankDaysBefore, 'rules.bankDaysBefore', 0),
      bankDaysAfter: integer(rules.bankDaysAfter, 'rules.bankDaysAfter', 0),
      referencesShared: boolean(rules.referencesShared, 'rules.referencesShared'),
      referenceCaseInsensitive: boolean(rules.referenceCaseInsensitive, 'rules.referenceCaseInsensitive'),
    },
    sources: { bank: readSource(sources.bank, 'sources.bank'), books: readSource(sources.books, 'sources.books') },
    events,
    snapshots: root.snapshots.map(readSnapshot),
  }
}

export function importSession(text: string): SessionFile {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new SessionError('The file is not valid JSON')
  }
  return readSession(value)
}

export function exportSession(session: SessionFile): string {
  return JSON.stringify(session, null, 2)
}
