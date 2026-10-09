import { activeMatch, applyToState, checkDecision, checkPair, copyState, type DecisionEvent, eventKeys, type PairEvent, replay, structuralCheck } from '../../reconciliation/decisions'
import { type TransactionSnapshot } from '../../reconciliation/session'
import { type Direction, RECON_SIDES, type ReconSide, type Transaction } from '../../reconciliation/types'
import { type ConfirmedItem, type ReconRequests, type ReconResults, type RejectedItem, type TransactionView, type UnmatchedItem } from '../reconcile-protocol'
import { pageBounds } from '../paging'
import { matches, normalizeSearch } from '../search'
import { available, counts, currentReview, derive, expectNextSeq, directionOf, evidence, keyOf, openingItem, position, problemRows, replayData, resolve, resolveUnit, searchText, setKind, snapshot, type Source, suggestionItem, summary, texts, view, type Workspace } from './workspace'

// Review: replaying and recording decisions, sets, inspection and paged review tabs.

export function setDecisions(ws: Workspace, { matchId, events }: ReconRequests['setDecisions']): ReconResults['setDecisions'] {
  const { latest: run, normalized: data, review: state } = currentReview(ws, matchId)
  state.events = [...events]
  state.replay = replay(state.events, replayData(ws, run.rules))
  derive(ws, state, data)
  return summary(state, run.outcome)
}

export function getSet(ws: Workspace, { matchId, group }: ReconRequests['getSet']): ReconResults['getSet'] {
  const { latest: run, normalized: data, review: state } = currentReview(ws, matchId)
  const kind = setKind(ws, run.outcome, data, group)
  if (kind === null) throw new Error('This group is not a set of identical transactions')
  const members = run.outcome.groups[group]
  const open = (side: ReconSide, positions: number[]) =>
    positions
      .filter((p) => !state.used[side][p])
      .map((p) => data.pool[side][p])
      .sort((a, b) => a.index - b.index)
  const bank = open('bank', members.bank)
  const books = open('books', members.books)
  const rejectedInside = bank.some((b) => books.some((l) => state.rejected.has(`${position(ws, b)}:${position(ws, l)}`)))
  const blocked =
    kind !== 'interchangeable'
      ? 'The descriptions differ, so these transactions may not be interchangeable; confirm pairs one at a time'
      : bank.length === 0 || books.length === 0
        ? 'Nothing in this set is left to confirm'
        : rejectedInside
          ? 'A pair in this set was rejected; confirm pairs one at a time'
          : null
  return {
    group,
    kind,
    bank: bank.map((t) => view(ws, t, data.mappings.bank)),
    books: books.map((t) => view(ws, t, data.mappings.books)),
    blocked,
  }
}

export function decideSet(ws: Workspace, { matchId, group, seq, at, pairs }: ReconRequests['decideSet']): ReconResults['decideSet'] {
  const { latest: run, normalized: data, review: state } = currentReview(ws, matchId)
  expectNextSeq(state, seq)
  const set = getSet(ws, { matchId, group })
  if (set.blocked) return { ok: false, reason: set.blocked }
  if (pairs.length === 0) return { ok: false, reason: 'Choose at least one pair' }
  const bankKeys = new Set(set.bank.map((v) => v.key))
  const booksKeys = new Set(set.books.map((v) => v.key))
  if (!pairs.every((p) => bankKeys.has(p.bank) && booksKeys.has(p.books))) return { ok: false, reason: 'Every pair must come from this set' }
  // Check every pair against a copy first, so a failure leaves the history untouched.
  const trial = copyState(state.replay.state)
  const facts = replayData(ws, run.rules)
  const events: PairEvent[] = []
  for (const [i, pair] of pairs.entries()) {
    const decision = { action: 'confirm' as const, ...pair, origin: 'set' as const }
    const verdict = checkDecision(trial, decision, facts)
    if (!verdict.ok) return verdict
    const event: PairEvent = { seq: seq + i, at, ...decision }
    applyToState(trial, event)
    events.push(event)
  }
  for (const event of events) {
    state.events.push(event)
    applyToState(state.replay.state, event)
  }
  derive(ws, state, data)
  const snapshots = events.flatMap((e) => [snapshot(ws, e.bank), snapshot(ws, e.books)]).filter((s): s is TransactionSnapshot => s !== null)
  return { ok: true, events, snapshots, summary: summary(state, run.outcome) }
}

export const ALTERNATIVES = 20

export function inspect(ws: Workspace, { matchId, keys }: ReconRequests['inspect']): ReconResults['inspect'] {
  const { latest: run, normalized: data, review: state } = currentReview(ws, matchId)
  const ok = available(state)
  return keys.map((key) => {
    const t = resolve(ws, key)
    if (!t) return null
    const carried = openingItem(ws, t)
    const row = carried
      ? {
          headers: ['Lineage', 'Original date', 'Amount', 'Reference', 'Description', 'First left outstanding in', 'Record', 'Period'],
          values: [
            carried.lineage,
            carried.date,
            carried.amount,
            carried.reference ?? '',
            carried.description ?? '',
            carried.origin.fileName,
            String(carried.origin.recordNumber),
            `${carried.origin.period.start} to ${carried.origin.period.end}`,
          ],
        }
      : (() => {
          const file = (ws.sources[t.side] as Source).file
          return { headers: file.headers, values: file.headers.map((h) => file.rows[t.index][h]) }
        })()
    const own = position(ws, t)
    const otherSide: ReconSide = t.side === 'bank' ? 'books' : 'bank'
    const event = activeMatch(state.replay.state, t.side, key)
    const partner = event ? resolveUnit(ws, otherSide === 'bank' ? event.bank : event.books) : undefined
    const involving = run.outcome.candidates.filter((c) => (t.side === 'bank' ? c.bank : c.books) === own && ok(c))
    let rejectedPairs = 0
    for (const e of state.replay.state.rejected.values()) if (e.bank === key || e.books === key) rejectedPairs++
    return {
      view: view(ws, t, data.mappings[t.side]),
      ...row,
      match: partner && event ? { other: view(ws, partner, data.mappings[otherSide]), event } : null,
      alternatives: involving.slice(0, ALTERNATIVES).map((c) => suggestionItem(ws, run.outcome, data, c)),
      alternativesTotal: involving.length,
      rejectedPairs,
    }
  })
}

export function decide(ws: Workspace, { matchId, seq, at, decision }: ReconRequests['decide']): ReconResults['decide'] {
  const { latest: run, normalized: data, review: state } = currentReview(ws, matchId)
  expectNextSeq(state, seq)
  // Mark-complete needs the balances and statuses; it goes through markComplete.
  if (decision.action === 'complete') throw new Error('Mark complete through the completion check')
  const verdict = checkDecision(state.replay.state, decision, replayData(ws, run.rules))
  if (!verdict.ok) return verdict
  const event = { seq, at, ...decision } as DecisionEvent
  state.events.push(event)
  applyToState(state.replay.state, event)
  derive(ws, state, data)
  const snapshots = eventKeys(event).map((key) => snapshot(ws, key)).filter((s): s is TransactionSnapshot => s !== null)
  return { ok: true, event, snapshots, summary: summary(state, run.outcome) }
}

export function pairCheck(ws: Workspace, { matchId, bank, books }: ReconRequests['checkPair']): ReconResults['checkPair'] {
  const { latest: run, normalized: data, review: state } = currentReview(ws, matchId)
  const bankTxn = resolveUnit(ws, bank)
  const booksTxn = resolveUnit(ws, books)
  const pair = checkPair(bankTxn, booksTxn, run.rules)
  const structural = structuralCheck(state.replay.state, { action: 'confirm', bank, books })
  return {
    blocked: pair.blocked ?? (structural.ok ? null : structural.reason),
    exceptions: pair.exceptions,
    bank: bankTxn ? view(ws, bankTxn, data.mappings.bank) : null,
    books: booksTxn ? view(ws, booksTxn, data.mappings.books) : null,
  }
}

export function getReview(ws: Workspace, { matchId, tab, offset, limit, search, direction, unclassified }: ReconRequests['getReview']): ReconResults['getReview'] {
  const { latest: run, normalized: data, review: state } = currentReview(ws, matchId)
  const { outcome } = run
  const { pool, mappings } = data
  const [start, end] = pageBounds(offset, limit)
  const needle = normalizeSearch(search)
  const filtered = <T,>(build: () => T[], keep: (item: T) => boolean): T[] =>
    ws.searchCache.get(`${matchId}\u0000${state.version}\u0000${tab}\u0000${direction ?? ''}\u0000${unclassified ? 'u' : ''}\u0000${needle}`, () =>
      needle === '' && direction === undefined && !unclassified ? build() : build().filter(keep),
    )
  const isDirection = (d: Direction) => direction === undefined || d === direction
  const both = (a: TransactionView | null, b: TransactionView | null) => [...(a ? texts(a) : []), ...(b ? texts(b) : [])]

  switch (tab) {
    case 'suggested': {
      const ok = available(state)
      const all = filtered(
        () => outcome.candidates.filter(ok),
        (c) =>
          ok(c) &&
          isDirection(directionOf(pool.bank[c.bank])) &&
          (needle === '' || searchText(ws, data, 'bank', c.bank).includes(needle) || searchText(ws, data, 'books', c.books).includes(needle)),
      )
      const items = all.slice(start, end).map((c) => suggestionItem(ws, run.outcome, data, c))
      return { tab, total: all.length, offset: start, items }
    }
    case 'confirmed': {
      const confirmed = (): ConfirmedItem[] =>
        [...state.replay.state.active.values()]
          .sort((a, b) => a.seq - b.seq)
          .map((event) => {
            const bank = resolveUnit(ws, event.bank) as Transaction
            const books = resolveUnit(ws, event.books) as Transaction
            return { bank: view(ws, bank, mappings.bank), books: view(ws, books, mappings.books), event, ...evidence(bank, books, run.rules) }
          })
      const all = filtered(confirmed, (item) => isDirection(item.bank.direction) && (needle === '' || matches([...both(item.bank, item.books), item.event.reason ?? ''], needle)))
      return { tab, total: all.length, offset: start, items: all.slice(start, end) }
    }
    case 'unmatched': {
      const per = counts(state, outcome, data)
      const all = filtered(
        () => RECON_SIDES.flatMap((side) => pool[side].filter((_, p) => !state.used[side][p])),
        (t) =>
          isDirection(directionOf(t)) &&
          (!unclassified || !state.replay.state.classifications.get(keyOf(ws, t))?.classification) &&
          (needle === '' || searchText(ws, data, t.side, position(ws, t)).includes(needle)),
      )
      const items = all.slice(start, end).map((t): UnmatchedItem => {
        const v = view(ws, t, mappings[t.side])
        const classified = state.replay.state.classifications.get(v.key)
        const classification = classified?.classification ? { value: classified.classification, note: classified.note ?? null } : null
        return { ...v, suggestions: per[t.side][position(ws, t)], classification }
      })
      return { tab, total: all.length, offset: start, items }
    }
    case 'rejected': {
      const rejected = (): RejectedItem[] =>
        [...state.replay.state.rejected.values()]
          .sort((a, b) => a.seq - b.seq)
          .map((event) => {
            const bank = resolveUnit(ws, event.bank)
            const books = resolveUnit(ws, event.books)
            return {
              bankKey: event.bank,
              booksKey: event.books,
              bank: bank ? view(ws, bank, mappings.bank) : null,
              books: books ? view(ws, books, mappings.books) : null,
              event,
            }
          })
      const all = filtered(rejected, (item) => (item.bank === null || isDirection(item.bank.direction)) && (needle === '' || matches(both(item.bank, item.books), needle)))
      return { tab, total: all.length, offset: start, items: all.slice(start, end) }
    }
    case 'problems': {
      const all = filtered(
        () => problemRows(ws, data),
        // Problem rows have no trustworthy direction, so the direction filter does not apply.
        (p) => matches([...p.messages, p.original.date, ...p.original.amount, p.original.reference ?? '', p.original.description ?? ''], needle),
      )
      return { tab, total: all.length, offset: start, items: all.slice(start, end) }
    }
  }
}
