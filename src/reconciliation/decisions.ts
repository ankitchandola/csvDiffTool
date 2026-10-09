import { allCarried, mixedDirections } from './groups'
import { booksWindow, referencesAgree } from './match'
import type { Direction, MatchingRules, ReconSide, Transaction } from './types'

// A transaction's identity across reruns: its side, the SHA-256 of its source file and
// its record number. Replacing the file changes the fingerprint, so decisions about the
// old file can never attach to a new one.
export type TxnKey = string

export function txnKey(side: ReconSide, fingerprint: string, recordNumber: number): TxnKey {
  return `${side}|${fingerprint}|${recordNumber}`
}

// A SHA-256 digest as lower-case hex: exactly 64 characters from 0-9 and a-f.
export function isSha256Hex(text: string): boolean {
  if (text.length !== 64) return false
  for (const ch of text) if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return false
  return true
}

export function parseTxnKey(key: TxnKey): { side: ReconSide; fingerprint: string; recordNumber: number } | null {
  const [side, fingerprint, record] = key.split('|')
  const recordNumber = Number(record)
  if ((side !== 'bank' && side !== 'books') || !isSha256Hex(fingerprint ?? '') || !Number.isInteger(recordNumber) || recordNumber < 1) {
    return null
  }
  return { side, fingerprint, recordNumber }
}

// What one side of a match holds: a transaction, or a group of transactions on that side.
// A group's key lists its members, so its identity is exactly its members: segments
// "side|fingerprint|record+record" joined by "&", one per file, in canonical order. A
// single transaction's unit key is its transaction key.
export function unitKey(members: TxnKey[]): TxnKey {
  const parsed = members.map(parseTxnKey)
  const side = parsed[0]?.side
  if (!side || parsed.some((p) => p?.side !== side)) throw new Error('A group holds transactions from one side only')
  const records = new Map<string, number[]>()
  for (const p of parsed as NonNullable<(typeof parsed)[number]>[]) {
    const list = records.get(p.fingerprint)
    if (list) list.push(p.recordNumber)
    else records.set(p.fingerprint, [p.recordNumber])
  }
  return [...records.keys()]
    .sort()
    .map((fingerprint) => {
      const numbers = (records.get(fingerprint) as number[]).sort((a, b) => a - b)
      if (numbers.some((n, i) => n === numbers[i - 1])) throw new Error('A transaction appears in the group twice')
      return `${side}|${fingerprint}|${numbers.join('+')}`
    })
    .join('&')
}

// The unit's side and member keys, or null for a key that isn't a unit key in canonical form.
export function parseUnitKey(key: TxnKey): { side: ReconSide; members: TxnKey[] } | null {
  if (!key.includes('&') && !key.includes('+')) {
    const single = parseTxnKey(key)
    return single && { side: single.side, members: [key] }
  }
  const members: TxnKey[] = []
  for (const segment of key.split('&')) {
    const [side, fingerprint, records, extra] = segment.split('|')
    if (extra !== undefined || records === undefined) return null
    for (const record of records.split('+')) members.push(`${side}|${fingerprint}|${record}`)
  }
  if (members.some((m) => parseTxnKey(m) === null)) return null
  try {
    if (unitKey(members) !== key) return null
  } catch {
    return null
  }
  return { side: (parseTxnKey(members[0]) as { side: ReconSide }).side, members }
}

export type PairAction = 'confirm' | 'reject' | 'restore' | 'unmatch'

export type DecisionAction = PairAction | 'classify' | 'complete'

export type ConfirmOrigin = 'suggested' | 'manual' | 'set'

// Soft rules a manual pair may break, with a reason. Direction is never one of them.
export type RuleException = 'amount' | 'date' | 'reference'

export interface PairEvent {
  // 1-based position in the session's history.
  seq: number
  at: string
  action: PairAction
  bank: TxnKey
  books: TxnKey
  // confirm only. 'set': one pair of a bulk-confirmed interchangeable set, whose
  // assignment within the set is arbitrary.
  origin?: ConfirmOrigin
  exceptions?: RuleException[]
  reason?: string
}

// What a remaining unmatched transaction is, once the reviewer has looked at it.
export type Classification = 'outstanding-payment' | 'deposit-in-transit' | 'record-in-books' | 'investigate'

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  'outstanding-payment': 'Outstanding payment (not yet cleared by the bank)',
  'deposit-in-transit': 'Deposit in transit (not yet credited by the bank)',
  'record-in-books': 'Bank entry to record in the books',
  investigate: 'Error to investigate',
}

// The classifications that make sense for a transaction; the first is the default the O
// key applies. Bank-only items need a books entry; books-only items await the bank.
export function classificationsFor(side: ReconSide, direction: Direction): Classification[] {
  if (side === 'bank') return ['record-in-books', 'investigate']
  return direction === 'out' ? ['outstanding-payment', 'investigate'] : ['deposit-in-transit', 'investigate']
}

export interface ClassifyEvent {
  seq: number
  at: string
  action: 'classify'
  key: TxnKey
  // Null clears an earlier classification.
  classification: Classification | null
  note?: string
}

// The reviewer's "mark complete". basis identifies the files, mappings, rules, balances
// and opening items it was given for; any change to them, or any later event, withdraws it.
export interface CompleteEvent {
  seq: number
  at: string
  action: 'complete'
  basis: string
}

export type DecisionEvent = PairEvent | ClassifyEvent | CompleteEvent

// A decision before the history numbers and dates it. Distributes over the union so each
// kind keeps its own fields.
export type NewDecision = DecisionEvent extends infer E ? (E extends DecisionEvent ? Omit<E, 'seq' | 'at'> : never) : never

// The transactions an event is about, with each group's members listed.
export function eventKeys(event: DecisionEvent): TxnKey[] {
  if (event.action === 'complete') return []
  const units = event.action === 'classify' ? [event.key] : [event.bank, event.books]
  return units.flatMap((key) => parseUnitKey(key)?.members ?? [key])
}

function membersOf(key: TxnKey): TxnKey[] {
  return parseUnitKey(key)?.members ?? [key]
}

export function isPairEvent(event: DecisionEvent): event is PairEvent {
  return event.action !== 'classify' && event.action !== 'complete'
}

export function edgeKey(bank: TxnKey, books: TxnKey): string {
  return `${bank}~${books}`
}

// What the history means now: active matches and rejected pairs.
export interface DecisionState {
  // The active confirm each transaction is in, by member key on each side.
  bankMatch: Map<TxnKey, PairEvent>
  booksMatch: Map<TxnKey, PairEvent>
  // Confirm event of each active match, by edge.
  active: Map<string, PairEvent>
  rejected: Map<string, PairEvent>
  classifications: Map<TxnKey, ClassifyEvent>
  // The latest mark-complete, if any; whether it still holds is decided by the caller.
  completion: CompleteEvent | null
  lastSeq: number
}

export function emptyState(): DecisionState {
  return { bankMatch: new Map(), booksMatch: new Map(), active: new Map(), rejected: new Map(), classifications: new Map(), completion: null, lastSeq: 0 }
}

// A copy to try decisions on; the events themselves are shared, as they are never changed.
export function copyState(state: DecisionState): DecisionState {
  return {
    bankMatch: new Map(state.bankMatch),
    booksMatch: new Map(state.booksMatch),
    active: new Map(state.active),
    rejected: new Map(state.rejected),
    classifications: new Map(state.classifications),
    completion: state.completion,
    lastSeq: state.lastSeq,
  }
}

export type Verdict = { ok: true } | { ok: false; reason: string }

// The active confirm a unit's transactions are in, if any.
export function activeMatch(state: DecisionState, side: ReconSide, key: TxnKey): PairEvent | undefined {
  const matched = side === 'bank' ? state.bankMatch : state.booksMatch
  for (const member of membersOf(key)) {
    const event = matched.get(member)
    if (event) return event
  }
  return undefined
}

// Rules that hold whatever the data: one active match per transaction, and a pair is
// active, rejected or neither.
export function structuralCheck(state: DecisionState, event: Pick<PairEvent, 'action' | 'bank' | 'books'> | NewDecision): Verdict {
  if (event.action === 'complete') return { ok: true }
  if (event.action === 'classify') {
    if (activeMatch(state, 'bank', event.key) || activeMatch(state, 'books', event.key)) return { ok: false, reason: 'A transaction in a confirmed match is not classified' }
    if (event.classification === null && !state.classifications.has(event.key)) return { ok: false, reason: 'This transaction is not classified' }
    return { ok: true }
  }
  const edge = edgeKey(event.bank, event.books)
  switch (event.action) {
    case 'confirm':
      if (state.rejected.has(edge)) return { ok: false, reason: 'This pair was rejected; restore it before confirming' }
      if (activeMatch(state, 'bank', event.bank)) return { ok: false, reason: 'The bank transaction is already in a confirmed match' }
      if (activeMatch(state, 'books', event.books)) return { ok: false, reason: 'The books transaction is already in a confirmed match' }
      return { ok: true }
    case 'reject':
      if (state.active.has(edge)) return { ok: false, reason: 'This pair is confirmed; unmatch it before rejecting' }
      if (state.rejected.has(edge)) return { ok: false, reason: 'This pair is already rejected' }
      return { ok: true }
    case 'restore':
      return state.rejected.has(edge) ? { ok: true } : { ok: false, reason: 'This pair is not rejected' }
    case 'unmatch':
      return state.active.has(edge) ? { ok: true } : { ok: false, reason: 'This pair is not confirmed' }
  }
}

export function applyToState(state: DecisionState, event: DecisionEvent): void {
  state.lastSeq = event.seq
  if (event.action === 'complete') {
    state.completion = event
    return
  }
  if (event.action === 'classify') {
    if (event.classification === null) state.classifications.delete(event.key)
    else state.classifications.set(event.key, event)
    return
  }
  const edge = edgeKey(event.bank, event.books)
  switch (event.action) {
    case 'confirm':
      for (const member of membersOf(event.bank)) state.bankMatch.set(member, event)
      for (const member of membersOf(event.books)) state.booksMatch.set(member, event)
      state.active.set(edge, event)
      return
    case 'unmatch':
      for (const member of membersOf(event.bank)) state.bankMatch.delete(member)
      for (const member of membersOf(event.books)) state.booksMatch.delete(member)
      state.active.delete(edge)
      return
    case 'reject':
      state.rejected.set(edge, event)
      return
    case 'restore':
      state.rejected.delete(edge)
      return
  }
}

export interface PairCheck {
  // Set when the pair can never be confirmed: an invalid or zero transaction, or
  // opposite cash directions.
  blocked: string | null
  exceptions: RuleException[]
}

function blocked(reason: string): PairCheck {
  return { blocked: reason, exceptions: [] }
}

// Hard and soft rules for one pair of valid units, under the current rules. A group the
// reviewer chose has no batch, and pairs only with a single transaction.
export function checkPair(bank: Transaction | undefined, books: Transaction | undefined, rules: MatchingRules): PairCheck {
  if (!bank) return blocked('The bank transaction is not a valid, nonzero transaction in the current files')
  if (!books) return blocked('The books transaction is not a valid, nonzero transaction in the current files')
  for (const unit of [bank, books]) {
    if (unit.members && mixedDirections(unit.members)) return blocked('A group’s transactions must all be money in or all money out')
  }
  if (bank.members && books.members && (bank.batch === undefined || books.batch === undefined)) {
    return blocked('Only one side of a match can hold several transactions')
  }
  if (bank.amount.units > 0n !== books.amount.units > 0n) return blocked('Money in cannot pair with money out')
  if (allCarried(bank) && allCarried(books)) {
    return blocked('Two carried items can’t clear each other; a carried item clears against a transaction from this period')
  }
  const grouped = bank.members !== undefined || books.members !== undefined
  if (grouped && bank.amount.units !== books.amount.units) return blocked('A group’s total must equal the other side exactly')
  const exceptions: RuleException[] = []
  if (bank.amount.units !== books.amount.units) exceptions.push('amount')
  const { earliest, latest } = booksWindow(bank.day, rules)
  if (books.day < earliest || books.day > latest) exceptions.push('date')
  if (referencesAgree(bank.reference, books.reference, rules) === false) exceptions.push('reference')
  return { blocked: null, exceptions }
}

export const EXCEPTION_LABELS: Record<RuleException, string> = {
  amount: 'amounts differ',
  date: 'dates are outside the window',
  reference: 'references differ',
}

export interface LapsedDecision {
  event: DecisionEvent
  reason: string
}

export interface ReplayData {
  // A valid, nonzero transaction or batch for the key in the current files, if any.
  transaction: (key: TxnKey) => Transaction | undefined
  // As transaction, and also a group of current transactions the reviewer chose.
  unit: (key: TxnKey) => Transaction | undefined
  // Whether the pair is a current suggestion (so it meets every rule).
  isCandidate: (bank: TxnKey, books: TxnKey) => boolean
  // Whether every file the key's transactions come from is loaded with the same fingerprint.
  sourcePresent: (key: TxnKey) => boolean
  rules: MatchingRules
}

// Checks a new decision against the history and the current data.
export function checkDecision(state: DecisionState, event: NewDecision, data: ReplayData): Verdict {
  const structural = structuralCheck(state, event)
  if (!structural.ok) return structural
  if (event.action === 'classify') {
    const t = data.transaction(event.key)
    if (!t) return { ok: false, reason: 'Only a valid, nonzero transaction in the current files can be classified' }
    if (event.classification !== null && !classificationsFor(t.side, t.amount.units > 0n ? 'in' : 'out').includes(event.classification)) {
      return { ok: false, reason: `“${CLASSIFICATION_LABELS[event.classification]}” does not fit this transaction` }
    }
    return { ok: true }
  }
  if (event.action !== 'confirm') return { ok: true }
  const pair = checkPair(data.unit(event.bank), data.unit(event.books), data.rules)
  if (pair.blocked) return { ok: false, reason: pair.blocked }
  if (event.origin === 'suggested' || event.origin === 'set') {
    return data.isCandidate(event.bank, event.books) ? { ok: true } : { ok: false, reason: 'This pair is no longer suggested under the current rules' }
  }
  const missing = pair.exceptions.filter((e) => !(event.exceptions ?? []).includes(e))
  if (missing.length > 0) return { ok: false, reason: `Give a reason: ${missing.map((e) => EXCEPTION_LABELS[e]).join(', ')}` }
  if (pair.exceptions.length > 0 && !event.reason?.trim()) return { ok: false, reason: 'A reason is required for a pair that breaks the rules' }
  return { ok: true }
}

export interface Replay {
  state: DecisionState
  lapsed: LapsedDecision[]
}

// Rebuilds the meaning of a history against the current files and rules. A decision
// that no longer holds lapses: it stays in the history, is listed with its reason, and
// never becomes current silently. Later events about a lapsed confirm are skipped.
export function replay(events: DecisionEvent[], data: ReplayData): Replay {
  const state = emptyState()
  const lapsed: LapsedDecision[] = []
  const lapsedConfirms = new Set<string>()
  for (const event of events) {
    if (event.action === 'complete') {
      applyToState(state, event)
      continue
    }
    if (event.action === 'classify') {
      const verdict = data.sourcePresent(event.key) ? checkDecision(state, event, data) : { ok: false as const, reason: 'Its source file was replaced or is not loaded' }
      if (verdict.ok) applyToState(state, event)
      else lapsed.push({ event, reason: verdict.reason })
      continue
    }
    const edge = edgeKey(event.bank, event.books)
    if (!data.sourcePresent(event.bank) || !data.sourcePresent(event.books)) {
      lapsed.push({ event, reason: 'Its source file was replaced or is not loaded' })
      if (event.action === 'confirm') lapsedConfirms.add(edge)
      continue
    }
    if (event.action === 'unmatch' && lapsedConfirms.has(edge)) {
      lapsedConfirms.delete(edge)
      continue
    }
    const verdict = event.action === 'confirm' ? checkDecision(state, event, data) : structuralCheck(state, event)
    if (!verdict.ok) {
      lapsed.push({ event, reason: verdict.reason })
      if (event.action === 'confirm') lapsedConfirms.add(edge)
      continue
    }
    applyToState(state, event)
  }
  return { state, lapsed }
}

export interface Pair {
  bank: TxnKey
  books: TxnKey
}

// Pairs the chosen members of an interchangeable set in the order given (source order),
// so the assignment is deterministic and visibly arbitrary. Both sides must have the
// same number of chosen members.
export function pairSet(bank: TxnKey[], books: TxnKey[]): Pair[] {
  if (bank.length !== books.length) throw new Error('Choose the same number of bank and books transactions')
  return bank.map((key, i) => ({ bank: key, books: books[i] }))
}
