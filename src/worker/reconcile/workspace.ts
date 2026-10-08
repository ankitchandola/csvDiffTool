import { formatDecimal } from '../../engine/decimal'
import { type Limits } from '../../engine/limits'
import { type ParseIssue } from '../../engine/parse'
import { type ParsedFile } from '../../engine/types'
import { type OutstandingFile, type OutstandingItem } from '../../reconciliation/carryforward'
import { isoDate } from '../../reconciliation/dates'
import { checkPair, type DecisionEvent, parseTxnKey, type Replay, replay, type ReplayData, txnKey, type TxnKey } from '../../reconciliation/decisions'
import { type Candidate, type MatchOutcome, type Tier } from '../../reconciliation/match'
import { type TransactionSnapshot } from '../../reconciliation/session'
import { type Direction, type MatchingRules, type NormalizedSide, RECON_SIDES, type ReconSide, type SessionContext, type SideMapping, type Transaction } from '../../reconciliation/types'
import { type DecisionSummary, type Location, type OriginalValues, type ProblemItem, type ReconPhase, type SetKind, type SuggestionItem, type TransactionView } from '../reconcile-protocol'
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
  // Each side's pool position by transaction key.
  positions?: Record<ReconSide, Map<TxnKey, number>>
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
  if (t.opening) return txnKey(t.side, ws.opening[t.opening.file].fingerprint, t.opening.item + 1)
  return txnKey(t.side, (ws.sources[t.side] as Source).fingerprint, t.index + 1)
}

export function view(ws: Workspace, t: Transaction, mapping: SideMapping): TransactionView {
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
  cache[position] ??= texts(view(ws, state.pool[side][position], state.mappings[side])).join('\u0000').toLowerCase()
  return cache[position] as string
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

export function resolve(ws: Workspace, key: TxnKey): Transaction | undefined {
  const parsed = parseTxnKey(key)
  if (!parsed || !ws.normalized) return undefined
  const position = positions(ws, ws.normalized)[parsed.side].get(key)
  return position === undefined ? undefined : ws.normalized.pool[parsed.side][position]
}

export function position(ws: Workspace, t: Transaction): number {
  return positions(ws, ws.normalized as Normalized)[t.side].get(keyOf(ws, t)) as number
}

// A key's file is loaded: the side's source file, or an imported opening-items file.
export function sourcePresent(ws: Workspace, key: TxnKey): boolean {
  const parsed = parseTxnKey(key)
  if (!parsed) return false
  return ws.sources[parsed.side]?.fingerprint === parsed.fingerprint || ws.opening.some((o) => o.fingerprint === parsed.fingerprint)
}

export function replayData(ws: Workspace, rules: MatchingRules): ReplayData {
  return {
    transaction: (key) => resolve(ws, key),
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

// Positions used by active matches and rejected position pairs, for fast filtering.
export function derive(ws: Workspace, state: ReviewState, data: Normalized) {
  const used = { bank: new Uint8Array(data.pool.bank.length), books: new Uint8Array(data.pool.books.length) }
  for (const event of state.replay.state.active.values()) {
    used.bank[position(ws, resolve(ws, event.bank) as Transaction)] = 1
    used.books[position(ws, resolve(ws, event.books) as Transaction)] = 1
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
  const t = resolve(ws, key)
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
