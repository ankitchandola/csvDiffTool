import { type Decimal, formatDecimal } from '../../engine/decimal'
import { type Limits } from '../../engine/limits'
import { type ParseIssue } from '../../engine/parse'
import { type ParsedFile } from '../../engine/types'
import { type RunningBalanceCheck } from '../../reconciliation/accounting'
import { type OutstandingFile, type OutstandingItem } from '../../reconciliation/carryforward'
import { isoDate } from '../../reconciliation/dates'
import { checkPair, type DecisionEvent, parseUnitKey, type Replay, replay, type ReplayData, txnKey, type TxnKey, unitKey } from '../../reconciliation/decisions'
import { groupOf } from '../../reconciliation/groups'
import { type Candidate, type MatchOutcome, type Tier } from '../../reconciliation/match'
import { type TransactionSnapshot } from '../../reconciliation/session'
import { type Direction, type MatchingRules, type NormalizedSide, RECON_SIDES, type ReconSide, type SessionContext, type SideMapping, type Transaction } from '../../reconciliation/types'
import { type DecisionSummary, type Location, type OriginalValues, type ProblemItem, GROUP_PREVIEW, type ReconPhase, type SetKind, type SuggestionItem, type TransactionView } from '../reconcile-protocol'
import { createSearchCache } from '../search'

// State the reconciliation worker keeps between requests, and the helpers every request
// group shares: transaction keys, views, positions, the decision state and lookups.

export type Reporter = (phase: ReconPhase, done: number, total: number) => void

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface Source {
  file: ParsedFile
  fingerprint: string
  name: string
}

// An outstanding-items file imported as opening items.
export interface OpeningSource {
  file: OutstandingFile
  // SHA-256 of the file's text, hex: the key prefix of its items.
  fingerprint: string
  name: string
  // Each side's items, in file order; Transaction.opening.item indexes these.
  items: Record<ReconSide, OutstandingItem[]>
}

export interface Normalized {
  revision: number
  context: SessionContext
  mappings: Record<ReconSide, SideMapping>
  sides: Record<ReconSide, NormalizedSide>
  // What matching and review work on: each side's current transactions, then its opening
  // items. Movement sums use only the current ones.
  pool: Record<ReconSide, Transaction[]>
  // Problems grouped per source row, in row order, with zero-value rows interleaved.
  problemRows: ProblemItem[] | null
  // Lower-cased searchable text per transaction position, built on first search.
  searchTexts?: Record<ReconSide, (string | undefined)[]>
  // Each side's pool position by unit key.
  positions?: Record<ReconSide, Map<TxnKey, number>>
  // Each batch member by its own key, built on first use.
  batchMembers?: Map<TxnKey, Transaction>
  // Each side's current movement and imported opening items in total, built on first use.
  totals?: Record<ReconSide, { current: Decimal; opening: Decimal }>
  // Running-balance checks by side, opening balance and basis: decisions don't change them.
  running?: Map<string, RunningBalanceCheck | null>
}

// The latest candidate search.
export interface Run {
  matchId: number
  revision: number
  outcome: MatchOutcome
  rules: MatchingRules
}

// The session's decision history as the worker last received it, and what it means now.
export interface ReviewState {
  matchId: number
  events: DecisionEvent[]
  replay: Replay
  // Bumped on every change, so cached filters are rebuilt.
  version: number
  used: Record<ReconSide, Uint8Array>
  rejected: Set<string>
  // Available suggestions per transaction position.
  counts: Record<ReconSide, Int32Array> | null
}

// Every parse or normalization starts a new revision; a match or page request for an
// older revision is rejected rather than served newer data.
export interface Workspace {
  limits: Limits
  sources: Partial<Record<ReconSide, Source>>
  issues: Partial<Record<ReconSide, ParseIssue[]>>
  generations: Record<ReconSide, number>
  opening: OpeningSource[]
  revision: number
  normalized: Normalized | null
  latest: Run | null
  review: ReviewState | null
  nextMatchId: number
  // Each group's set kind, computed on first use for the latest run.
  setKinds: Map<number, SetKind | null>
  searchCache: ReturnType<typeof createSearchCache>
}

export function createWorkspace(limits: Limits): Workspace {
  return {
    limits,
    sources: {},
    issues: {},
    generations: { bank: 0, books: 0 },
    opening: [],
    revision: 0,
    normalized: null,
    latest: null,
    review: null,
    nextMatchId: 1,
    setKinds: new Map(),
    searchCache: createSearchCache(),
  }
}

export function invalidate(ws: Workspace) {
  ws.revision++
  ws.normalized = null
  ws.latest = null
  ws.review = null
}

export function original(ws: Workspace, side: ReconSide, index: number, mapping: SideMapping): OriginalValues {
  const row = (ws.sources[side] as Source).file.rows[index]
  const { amount } = mapping
  return {
    date: row[mapping.date.column],
    amount: amount.kind === 'signed' ? [row[amount.column]] : [row[amount.inColumn], row[amount.outColumn]],
    reference: mapping.reference === null ? null : row[mapping.reference],
    description: mapping.description === null ? null : row[mapping.description],
  }
}

export function location(ws: Workspace, side: ReconSide, index: number): Location {
  return { side, recordNumber: index + 1, span: (ws.sources[side] as Source).file.spans?.[index] ?? null }
}

export function openingItem(ws: Workspace, t: Transaction): OutstandingItem | null {
  return t.opening ? ws.opening[t.opening.file].items[t.side][t.opening.item] : null
}

export function keyOf(ws: Workspace, t: Transaction): TxnKey {
  if (t.members) return unitKey(t.members.map((m) => keyOf(ws, m)))
  if (t.opening) return txnKey(t.side, ws.opening[t.opening.file].fingerprint, t.opening.item + 1)
  return txnKey(t.side, (ws.sources[t.side] as Source).fingerprint, t.index + 1)
}

export function view(ws: Workspace, t: Transaction, mapping: SideMapping): TransactionView {
  if (t.members) return groupView(ws, t, mapping)
  const base = {
    key: keyOf(ws, t),
    date: isoDate(t.day),
    amount: formatDecimal(t.amount),
    direction: t.amount.units > 0n ? ('in' as const) : ('out' as const),
    reference: t.reference,
  }
  const carried = openingItem(ws, t)
  if (carried) {
    return {
      ...base,
      side: t.side,
      recordNumber: carried.origin.recordNumber,
      span: null,
      carried: { lineage: carried.lineage, fileName: carried.origin.fileName, period: carried.origin.period },
      original: { date: carried.date, amount: [carried.amount], reference: carried.reference, description: carried.description },
    }
  }
  return { ...base, ...location(ws, t.side, t.index), original: original(ws, t.side, t.index, mapping) }
}

function groupLabel(t: Transaction): string {
  const count = (t.members as Transaction[]).length
  return t.batch === undefined ? `Group of ${count} transactions` : `Batch ${t.batch}: ${count} records`
}

function groupView(ws: Workspace, t: Transaction, mapping: SideMapping): TransactionView {
  const all = t.members as Transaction[]
  const members = all.slice(0, GROUP_PREVIEW).map((m) => view(ws, m, mapping))
  const { side, recordNumber, span } = members[0]
  const amount = formatDecimal(t.amount)
  return {
    key: keyOf(ws, t),
    side,
    recordNumber,
    span,
    date: isoDate(t.day),
    amount,
    direction: directionOf(t),
    reference: null,
    original: { date: isoDate(t.day), amount: [amount], reference: null, description: groupLabel(t) },
    group: { batch: t.batch ?? null, size: all.length, members },
  }
}

export function problemRows(ws: Workspace, state: Normalized): ProblemItem[] {
  state.problemRows ??= RECON_SIDES.flatMap((side) => {
    const items = new Map<number, ProblemItem>()
    for (const problem of state.sides[side].problems) {
      const item = items.get(problem.index)
      if (item) {
        item.fields.push(problem.field)
        item.messages.push(problem.message)
        continue
      }
      items.set(problem.index, {
        ...location(ws, side, problem.index),
        kind: 'invalid',
        fields: [problem.field],
        messages: [problem.message],
        original: original(ws, side, problem.index, state.mappings[side]),
      })
    }
    for (const index of state.sides[side].zero) {
      items.set(index, {
        ...location(ws, side, index),
        kind: 'zero',
        fields: [],
        messages: ['Zero amount: kept out of matching'],
        original: original(ws, side, index, state.mappings[side]),
      })
    }
    return [...items.values()].sort((a, b) => a.recordNumber - b.recordNumber)
  })
  return state.problemRows
}

export function texts(v: TransactionView): string[] {
  const { original: o } = v
  return [v.date, v.amount, o.date, ...o.amount, o.reference ?? '', o.description ?? '']
}

// Joined with NUL, which a trimmed search never contains, so a match can't span two values.
export function searchText(ws: Workspace, state: Normalized, side: ReconSide, position: number): string {
  state.searchTexts ??= { bank: [], books: [] }
  const cache = state.searchTexts[side]
  if (cache[position] === undefined) {
    const t = state.pool[side][position]
    // A group is found by any of its members, not only those in its preview.
    const views = [t, ...(t.members ?? [])].map((u) => view(ws, u, state.mappings[side]))
    cache[position] = views.flatMap(texts).join('\u0000').toLowerCase()
  }
  return cache[position]
}

export function directionOf(t: Transaction): Direction {
  return t.amount.units > 0n ? 'in' : 'out'
}

export function positions(ws: Workspace, state: Normalized): Record<ReconSide, Map<TxnKey, number>> {
  state.positions ??= {
    bank: new Map(state.pool.bank.map((t, position) => [keyOf(ws, t), position])),
    books: new Map(state.pool.books.map((t, position) => [keyOf(ws, t), position])),
  }
  return state.positions
}

function keySide(key: TxnKey): ReconSide | null {
  const side = key.slice(0, key.indexOf('|'))
  return side === 'bank' || side === 'books' ? side : null
}

// A unit in the pool: a transaction, or a batch.
export function resolve(ws: Workspace, key: TxnKey): Transaction | undefined {
  const side = keySide(key)
  if (!side || !ws.normalized) return undefined
  const position = positions(ws, ws.normalized)[side].get(key)
  return position === undefined ? undefined : ws.normalized.pool[side][position]
}

// A pool unit, or a group the reviewer chose of transactions that are each in the pool on
// their own: a batch member can't join one.
export function resolveUnit(ws: Workspace, key: TxnKey): Transaction | undefined {
  const pooled = resolve(ws, key)
  if (pooled) return pooled
  const members = parseUnitKey(key)?.members
  if (!members || members.length < 2) return undefined
  const found = members.map((member) => resolve(ws, member))
  if (found.some((t) => t === undefined || t.members)) return undefined
  return groupOf(found as Transaction[])
}

// Any single transaction in the pool, including a batch member.
export function resolveMember(ws: Workspace, key: TxnKey): Transaction | undefined {
  const pooled = resolve(ws, key)
  const state = ws.normalized
  if (pooled || !state) return pooled
  if (!state.batchMembers) {
    state.batchMembers = new Map()
    for (const side of RECON_SIDES) {
      for (const t of state.pool[side]) for (const m of t.members ?? []) state.batchMembers.set(keyOf(ws, m), m)
    }
  }
  return state.batchMembers.get(key)
}

// The pool positions a unit takes up: its own, or each member's for a chosen group.
export function unitPositions(ws: Workspace, key: TxnKey): { side: ReconSide; positions: number[] } | null {
  const parsed = parseUnitKey(key)
  if (!parsed || !ws.normalized) return null
  const where = positions(ws, ws.normalized)[parsed.side]
  const own = where.get(key)
  if (own !== undefined) return { side: parsed.side, positions: [own] }
  const members = parsed.members.map((m) => where.get(m))
  return members.every((p) => p !== undefined) ? { side: parsed.side, positions: members as number[] } : null
}

export function position(ws: Workspace, t: Transaction): number {
  return positions(ws, ws.normalized as Normalized)[t.side].get(keyOf(ws, t)) as number
}

// Every file a unit's transactions come from is loaded: the side's source file, or an
// imported opening-items file.
export function sourcePresent(ws: Workspace, key: TxnKey): boolean {
  const parsed = parseUnitKey(key)
  if (!parsed) return false
  return parsed.members.every((member) => {
    const fingerprint = member.split('|')[1]
    return ws.sources[parsed.side]?.fingerprint === fingerprint || ws.opening.some((o) => o.fingerprint === fingerprint)
  })
}

export function replayData(ws: Workspace, rules: MatchingRules): ReplayData {
  return {
    transaction: (key) => resolve(ws, key),
    unit: (key) => resolveUnit(ws, key),
    // A pair that meets every rule is a suggestion, whether or not a budget-limited search listed it.
    isCandidate: (bank, books) => {
      const pair = checkPair(resolve(ws, bank), resolve(ws, books), rules)
      return pair.blocked === null && pair.exceptions.length === 0
    },
    sourcePresent: (key) => sourcePresent(ws, key),
    rules,
  }
}

export function current(ws: Workspace, forRevision: number): Normalized {
  if (ws.normalized?.revision !== forRevision) throw new Error('The files or mappings changed; check the mapping again')
  return ws.normalized
}

export function currentReview(ws: Workspace, matchId: number) {
  if (!ws.latest || !ws.normalized) throw new Error('Find suggestions first')
  if (matchId !== ws.latest.matchId || ws.latest.revision !== ws.normalized.revision) throw new Error('These suggestions were replaced by a newer run')
  ws.review ??= { matchId, events: [], replay: replay([], replayData(ws, ws.latest.rules)), version: 0, used: { bank: new Uint8Array(0), books: new Uint8Array(0) }, rejected: new Set(), counts: null }
  return { latest: ws.latest, normalized: ws.normalized, review: ws.review }
}

// A new decision must follow the last one recorded; otherwise the page and the worker
// hold different histories.
export function expectNextSeq(state: ReviewState, seq: number): void {
  if (seq !== state.events.length + 1) throw new Error('The decision history is out of step with this session; reload the session')
}

// Positions used by active matches and rejected position pairs, for fast filtering.
export function derive(ws: Workspace, state: ReviewState, data: Normalized) {
  const used = { bank: new Uint8Array(data.pool.bank.length), books: new Uint8Array(data.pool.books.length) }
  for (const event of state.replay.state.active.values()) {
    for (const key of [event.bank, event.books]) {
      const unit = unitPositions(ws, key) as { side: ReconSide; positions: number[] }
      for (const p of unit.positions) used[unit.side][p] = 1
    }
  }
  const rejected = new Set<string>()
  for (const event of state.replay.state.rejected.values()) {
    const bank = resolve(ws, event.bank)
    const books = resolve(ws, event.books)
    if (bank && books) rejected.add(`${position(ws, bank)}:${position(ws, books)}`)
  }
  state.used = used
  state.rejected = rejected
  state.counts = null
  state.version++
}

export function available(state: ReviewState) {
  return (c: { bank: number; books: number }) => !state.used.bank[c.bank] && !state.used.books[c.books] && !state.rejected.has(`${c.bank}:${c.books}`)
}

export function counts(state: ReviewState, outcome: MatchOutcome, data: Normalized): Record<ReconSide, Int32Array> {
  if (!state.counts) {
    const result = { bank: new Int32Array(data.pool.bank.length), books: new Int32Array(data.pool.books.length) }
    const ok = available(state)
    for (const c of outcome.candidates) {
      if (!ok(c)) continue
      result.bank[c.bank]++
      result.books[c.books]++
    }
    state.counts = result
  }
  return state.counts
}

export function summary(state: ReviewState, outcome: MatchOutcome): DecisionSummary {
  const ok = available(state)
  let suggested = 0
  for (const c of outcome.candidates) if (ok(c)) suggested++
  const unmatched = (side: ReconSide) => state.used[side].length - state.used[side].reduce((n, u) => n + u, 0)
  return {
    suggested,
    confirmed: state.replay.state.active.size,
    unmatched: { bank: unmatched('bank'), books: unmatched('books') },
    rejected: state.replay.state.rejected.size,
    lapsed: state.replay.lapsed.map(({ event, reason }) => ({ event, reason })),
  }
}

export function snapshot(ws: Workspace, key: TxnKey): TransactionSnapshot | null {
  const t = resolveMember(ws, key)
  if (!t || !ws.normalized) return null
  const description = ws.normalized.mappings[t.side].description
  return {
    key,
    date: isoDate(t.day),
    amount: formatDecimal(t.amount),
    direction: t.amount.units > 0n ? 'in' : 'out',
    reference: t.reference,
    description: t.opening ? (openingItem(ws, t) as OutstandingItem).description : description === null ? null : (ws.sources[t.side] as Source).file.rows[t.index][description],
  }
}

export function suggestionItem(ws: Workspace, outcome: MatchOutcome, data: Normalized, c: Candidate): SuggestionItem {
  const group = outcome.groups[c.group]
  return {
    group: c.group,
    groupBank: group.bank.length,
    groupBooks: group.books.length,
    groupPairs: group.pairs,
    unique: group.unique,
    tier: c.tier,
    gap: c.gap,
    bank: view(ws, data.pool.bank[c.bank], data.mappings.bank),
    books: view(ws, data.pool.books[c.books], data.mappings.books),
    set: setKind(ws, outcome, data, c.group),
  }
}

export function descriptionOf(ws: Workspace, data: Normalized, t: Transaction): string {
  if (t.members) return groupLabel(t)
  const carried = openingItem(ws, t)
  if (carried) return (carried.description ?? '').trim()
  const column = data.mappings[t.side].description
  return column === null ? '' : (ws.sources[t.side] as Source).file.rows[t.index][column].trim()
}

export function setKind(ws: Workspace, outcome: MatchOutcome, data: Normalized, groupId: number): SetKind | null {
  const cached = ws.setKinds.get(groupId)
  if (cached !== undefined) return cached
  const group = outcome.groups[groupId]
  let kind: SetKind | null = null
  if (!group.unique) {
    const same = (side: ReconSide, positions: number[]) => {
      const all = positions.map((p) => data.pool[side][p])
      const first = all[0]
      const fields = all.every((t) => t.day === first.day && t.amount.units === first.amount.units && t.reference === first.reference)
      const descriptions = all.every((t) => descriptionOf(ws, data, t) === descriptionOf(ws, data, first))
      return { fields, descriptions }
    }
    const bank = same('bank', group.bank)
    const books = same('books', group.books)
    if (bank.fields && books.fields) kind = bank.descriptions && books.descriptions ? 'interchangeable' : 'different-descriptions'
  }
  ws.setKinds.set(groupId, kind)
  return kind
}

export function evidence(bank: Transaction, books: Transaction, rules: MatchingRules): { tier: Tier | null; gap: number } {
  const gap = bank.day - books.day
  const pair = checkPair(bank, books, rules)
  if (pair.blocked !== null || pair.exceptions.length > 0) return { tier: null, gap }
  return { tier: rules.referencesShared && bank.reference !== null && books.reference !== null ? 1 : 3, gap }
}
