import { type Decimal, formatDecimal, parseDecimal, subtractDecimal, toScale } from '../engine/decimal'
import { type BalanceBasis, cashBalance, checkRunningBalance, computeBridge, type RunningBalanceCheck, sum } from '../reconciliation/accounting'
import {
  buildOutstandingFile,
  checkImport,
  type OutstandingFile,
  type OutstandingItem,
  type OutstandingSource,
  openingTransactions,
  readOutstandingFile,
} from '../reconciliation/carryforward'
import { placeLabel } from '../reconciliation/location'
import { type ReconciliationReport, REPORT_FORMAT, REPORT_VERSION, type ReportMatch, type ReportOutstanding, type ReportProblem, type ReportTransaction, reportJson, reportTables } from '../reconciliation/report'
import { computeStatuses, type ReviewFacts } from '../reconciliation/statuses'
import type { AccountingSetup } from '../reconciliation/session'
import { DEFAULT_LIMITS, type Limits } from '../engine/limits'
import type { ParseIssue } from '../engine/parse'
import type { ParsedFile } from '../engine/types'
import { isoDate } from '../reconciliation/dates'
import {
  applyToState,
  checkDecision,
  checkPair,
  type DecisionEvent,
  type DecisionState,
  edgeKey,
  eventKeys,
  type PairEvent,
  parseTxnKey,
  type Replay,
  replay,
  type ReplayData,
  structuralCheck,
  type TxnKey,
  txnKey,
} from '../reconciliation/decisions'
import { type Candidate, findCandidates, type MatchOutcome, type Tier } from '../reconciliation/match'
import type { TransactionSnapshot } from '../reconciliation/session'
import { contextIssues, mappingIssues, normalizeSide } from '../reconciliation/normalize'
import {
  type Direction,
  type MatchingRules,
  type NormalizationProblem,
  type NormalizedSide,
  RECON_SIDES,
  type ReconSide,
  type SessionContext,
  type SideMapping,
  type Transaction,
} from '../reconciliation/types'
import { MAX_PAGE_SIZE, type Preview, PREVIEW_ISSUES, PREVIEW_RECORDS } from './protocol'
import { readSource } from './read-source'
import {
  type AccountingReport,
  type OpeningOverlap,
  type ConfirmedItem,
  type DecisionSummary,
  type Location,
  type OriginalValues,
  PREVIEW_SKIPPED,
  type ProblemItem,
  type RejectedItem,
  type SetKind,
  type ReconPhase,
  type ReconRequest,
  type ReconRequests,
  type ReconResults,
  SAMPLE_ROWS,
  type SampleRow,
  type SideSummary,
  type SuggestionItem,
  type TransactionView,
  type UnmatchedItem,
} from './reconcile-protocol'
import { createSearchCache, matches, normaliseSearch } from './search'

type Reporter = (phase: ReconPhase, done: number, total: number) => void

function preview<T>(items: T[], size: number): Preview<T> {
  return { items: items.slice(0, size), total: items.length }
}

function pageBounds(offset: number, limit: number): [number, number] {
  const start = Math.max(0, Math.floor(offset))
  return [start, start + Math.min(MAX_PAGE_SIZE, Math.max(0, Math.floor(limit)))]
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

interface Source {
  file: ParsedFile
  fingerprint: string
  name: string
}

// An outstanding-items file imported as opening items.
interface OpeningSource {
  file: OutstandingFile
  // SHA-256 of the file's text, hex: the key prefix of its items.
  fingerprint: string
  name: string
  // Each side's items, in file order; Transaction.opening.item indexes these.
  items: Record<ReconSide, OutstandingItem[]>
}

interface Normalized {
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

// Owns parsed sources, normalized transactions and the latest suggestions, so full data
// never crosses to the UI thread. Every parse or normalization starts a new revision; a
// match or page request for an older revision is rejected rather than served newer data.
export function createReconcileHandler(limits: Limits = DEFAULT_LIMITS) {
  const sources: Partial<Record<ReconSide, Source>> = {}
  const issues: Partial<Record<ReconSide, ParseIssue[]>> = {}
  const generations: Record<ReconSide, number> = { bank: 0, books: 0 }
  let opening: OpeningSource[] = []
  let revision = 0
  let normalized: Normalized | null = null
  let latest: { matchId: number; revision: number; outcome: MatchOutcome; rules: MatchingRules } | null = null
  // The session's decision history as the worker last received it, and what it means now.
  let review: {
    matchId: number
    events: DecisionEvent[]
    replay: Replay
    // Bumped on every change, so cached filters are rebuilt.
    version: number
    used: Record<ReconSide, Uint8Array>
    rejected: Set<string>
    // Available suggestions per transaction position.
    counts: Record<ReconSide, Int32Array> | null
  } | null = null
  let nextMatchId = 1
  // Each group's set kind, computed on first use for the latest run.
  const setKinds = new Map<number, SetKind | null>()
  const searchCache = createSearchCache()

  function invalidate() {
    revision++
    normalized = null
    latest = null
    review = null
  }

  async function parse({ side, file, delimiter, sheet, layout }: ReconRequests['parse'], onProgress?: Reporter): Promise<ReconResults['parse']> {
    delete sources[side]
    delete issues[side]
    invalidate()
    const generation = ++generations[side]
    const { outcome, bytes } = await readSource(
      file,
      { rules: { delimiter, trimHeaders: true }, sheet, layout },
      limits,
      () => generation === generations[side],
      onProgress && ((_, done, total) => onProgress('parse', done, total)),
    )
    if (!outcome.ok) {
      issues[side] = outcome.issues
      return { ok: false, issues: preview(outcome.issues, PREVIEW_ISSUES), ...(outcome.format && { format: outcome.format }) }
    }
    const fingerprint = await sha256(bytes as ArrayBuffer)
    if (generation !== generations[side]) throw new Error('Superseded by a newer file')
    sources[side] = { file: outcome.file, fingerprint, name: file.name }
    const { headers, rows, format, notes, skipped } = outcome.file
    return {
      ok: true,
      info: {
        headers,
        format,
        notes,
        recordCount: rows.length,
        preview: rows.slice(0, PREVIEW_RECORDS),
        fingerprint,
        skipped: {
          before: preview(skipped?.before ?? [], PREVIEW_SKIPPED),
          after: preview(skipped?.after ?? [], PREVIEW_SKIPPED),
        },
      },
    }
  }

  function getIssues({ side, offset, limit }: ReconRequests['getIssues']): ReconResults['getIssues'] {
    const all = issues[side] ?? []
    const [start, end] = pageBounds(offset, limit)
    return { side, total: all.length, offset: start, items: all.slice(start, end) }
  }

  function original(side: ReconSide, index: number, mapping: SideMapping): OriginalValues {
    const row = (sources[side] as Source).file.rows[index]
    const { amount } = mapping
    return {
      date: row[mapping.date.column],
      amount: amount.kind === 'signed' ? [row[amount.column]] : [row[amount.inColumn], row[amount.outColumn]],
      reference: mapping.reference === null ? null : row[mapping.reference],
      description: mapping.description === null ? null : row[mapping.description],
    }
  }

  function location(side: ReconSide, index: number): Location {
    return { side, recordNumber: index + 1, span: (sources[side] as Source).file.spans?.[index] ?? null }
  }

  function openingItem(t: Transaction): OutstandingItem | null {
    return t.opening ? opening[t.opening.file].items[t.side][t.opening.item] : null
  }

  function keyOf(t: Transaction): TxnKey {
    if (t.opening) return txnKey(t.side, opening[t.opening.file].fingerprint, t.opening.item + 1)
    return txnKey(t.side, (sources[t.side] as Source).fingerprint, t.index + 1)
  }

  function view(t: Transaction, mapping: SideMapping): TransactionView {
    const base = {
      key: keyOf(t),
      date: isoDate(t.day),
      amount: formatDecimal(t.amount),
      direction: t.amount.units > 0n ? ('in' as const) : ('out' as const),
      reference: t.reference,
    }
    const carried = openingItem(t)
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
    return { ...base, ...location(t.side, t.index), original: original(t.side, t.index, mapping) }
  }

  function summarize(side: ReconSide, result: NormalizedSide, mapping: SideMapping): SideSummary {
    const rows = (sources[side] as Source).file.rows.length
    const byIndex = new Map<number, NormalizationProblem[]>()
    for (const problem of result.problems) byIndex.set(problem.index, [...(byIndex.get(problem.index) ?? []), problem])
    const valid = new Map(result.transactions.filter((t) => t.index < SAMPLE_ROWS).map((t) => [t.index, t]))
    const zero = new Set(result.zero)
    const sample: SampleRow[] = []
    for (let index = 0; index < Math.min(rows, SAMPLE_ROWS); index++) {
      const t = valid.get(index)
      sample.push({
        ...location(side, index),
        original: original(side, index, mapping),
        normalized: t ? { date: isoDate(t.day), amount: formatDecimal(t.amount), direction: t.amount.units > 0n ? 'in' : 'out' } : null,
        zero: zero.has(index),
        problems: (byIndex.get(index) ?? []).map((p) => p.message),
      })
    }
    const moneyIn = result.transactions.filter((t) => t.amount.units > 0n).length
    return {
      rows,
      valid: result.transactions.length,
      moneyIn,
      moneyOut: result.transactions.length - moneyIn,
      zero: result.zero.length,
      problemRows: byIndex.size,
      problems: result.problems.length,
      sample,
    }
  }

  async function setOpening({ files }: ReconRequests['setOpening']): Promise<ReconResults['setOpening']> {
    const read: OpeningSource[] = []
    const errors: { name: string; message: string }[] = []
    for (const { name, text } of files) {
      try {
        const file = readOutstandingFile(JSON.parse(text))
        const fingerprint = await sha256(new TextEncoder().encode(text).buffer as ArrayBuffer)
        const items = { bank: file.items.filter((i) => i.side === 'bank'), books: file.items.filter((i) => i.side === 'books') }
        read.push({ file, fingerprint, name, items })
      } catch (error) {
        errors.push({ name, message: error instanceof SyntaxError ? 'The file is not valid JSON' : error instanceof Error ? error.message : String(error) })
      }
    }
    if (errors.length > 0) return { ok: false, errors }
    opening = read
    invalidate()
    return {
      ok: true,
      files: read.map((o) => ({ name: o.name, fingerprint: o.fingerprint, period: o.file.period, account: o.file.account, items: o.file.items.length, cleared: o.file.cleared.length })),
    }
  }

  function normalize({ context, mappings, period }: ReconRequests['normalize'], onProgress?: Reporter): ReconResults['normalize'] {
    const found: { side: ReconSide | null; message: string }[] = contextIssues(context).map((message) => ({ side: null, message }))
    for (const side of RECON_SIDES) {
      const source = sources[side]
      if (!source) found.push({ side, message: 'Load this file first' })
      else found.push(...mappingIssues(mappings[side], source.file.headers).map((message) => ({ side, message })))
    }
    if (found.length > 0) return { ok: false, issues: found }
    invalidate()
    const sides = {} as Record<ReconSide, NormalizedSide>
    RECON_SIDES.forEach((side, i) => {
      onProgress?.('normalize', i, RECON_SIDES.length)
      sides[side] = normalizeSide(side, (sources[side] as Source).file, mappings[side], context)
    })
    onProgress?.('normalize', RECON_SIDES.length, RECON_SIDES.length)

    // Opening items are checked against this session before they join the pool.
    const current = { bank: sides.bank.transactions, books: sides.books.transactions }
    const imported = new Set<string>()
    const clearedElsewhere = new Set<string>()
    const openingErrors: { side: ReconSide | null; message: string }[] = []
    const warnings: string[] = []
    const overlaps: OpeningOverlap[] = []
    if (opening.length > 0 && !period) openingErrors.push({ side: null, message: 'Enter the period before importing opening items' })
    if (period) {
      for (const o of opening) {
        const check = checkImport(o.file, { context, period, imported, clearedElsewhere, current })
        openingErrors.push(...check.errors.map((message) => ({ side: null, message: `${o.name}: ${message}` })))
        warnings.push(...check.warnings.map((message) => `${o.name}: ${message}`))
        overlaps.push(...check.overlaps.map((v) => ({ lineage: v.lineage, side: v.side, records: v.current.map((p) => current[v.side][p].index + 1) })))
        for (const item of o.file.items) imported.add(item.lineage)
        for (const lineage of o.file.cleared) clearedElsewhere.add(lineage)
      }
    }
    if (openingErrors.length > 0) return { ok: false, issues: openingErrors }
    const pool = { bank: [...current.bank], books: [...current.books] }
    opening.forEach((o, f) => {
      for (const side of RECON_SIDES) {
        pool[side].push(...openingTransactions(o.file, side, context.minorUnits).map((t) => ({ ...t, opening: { file: f, item: t.index } })))
      }
    })
    normalized = { revision, context, mappings, sides, pool, problemRows: null }
    return {
      ok: true,
      revision,
      sides: { bank: summarize('bank', sides.bank, mappings.bank), books: summarize('books', sides.books, mappings.books) },
      opening: { items: { bank: pool.bank.length - current.bank.length, books: pool.books.length - current.books.length }, warnings, overlaps },
    }
  }

  function current(forRevision: number): Normalized {
    if (normalized?.revision !== forRevision) throw new Error('The files or mappings changed; check the mapping again')
    return normalized
  }

  function match({ revision: forRevision, rules }: ReconRequests['match'], onProgress?: Reporter): ReconResults['match'] {
    const { pool, sides } = current(forRevision)
    latest = null
    onProgress?.('match', 0, 1)
    const outcome = findCandidates(pool.bank, pool.books, rules)
    onProgress?.('match', 1, 1)
    const matchId = nextMatchId++
    latest = { matchId, revision: forRevision, outcome, rules }
    review = null
    setKinds.clear()
    const per = (count: (side: ReconSide) => number) => ({ bank: count('bank'), books: count('books') })
    return {
      matchId,
      revision: forRevision,
      rules,
      pairs: outcome.candidates.length,
      groups: outcome.groups.length,
      uniqueGroups: outcome.groups.filter((g) => g.unique).length,
      withCandidates: per((side) => pool[side].length - outcome.noCandidate[side].length),
      noCandidate: per((side) => outcome.noCandidate[side].length),
      invalid: per((side) => new Set(sides[side].problems.map((p) => p.index)).size),
      zero: per((side) => sides[side].zero.length),
      referenceConflicts: outcome.referenceConflicts,
      incomplete: outcome.incomplete,
    }
  }

  function problemRows(state: Normalized): ProblemItem[] {
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
          ...location(side, problem.index),
          kind: 'invalid',
          fields: [problem.field],
          messages: [problem.message],
          original: original(side, problem.index, state.mappings[side]),
        })
      }
      for (const index of state.sides[side].zero) {
        items.set(index, {
          ...location(side, index),
          kind: 'zero',
          fields: [],
          messages: ['Zero amount: kept out of matching'],
          original: original(side, index, state.mappings[side]),
        })
      }
      return [...items.values()].sort((a, b) => a.recordNumber - b.recordNumber)
    })
    return state.problemRows
  }

  function texts(v: TransactionView): string[] {
    const { original: o } = v
    return [v.date, v.amount, o.date, ...o.amount, o.reference ?? '', o.description ?? '']
  }

  // Joined with NUL, which a trimmed search never contains, so a match can't span two values.
  function searchText(state: Normalized, side: ReconSide, position: number): string {
    state.searchTexts ??= { bank: [], books: [] }
    const cache = state.searchTexts[side]
    cache[position] ??= texts(view(state.pool[side][position], state.mappings[side])).join('\u0000').toLowerCase()
    return cache[position] as string
  }

  function directionOf(t: Transaction): Direction {
    return t.amount.units > 0n ? 'in' : 'out'
  }

  function positions(state: Normalized): Record<ReconSide, Map<TxnKey, number>> {
    state.positions ??= {
      bank: new Map(state.pool.bank.map((t, position) => [keyOf(t), position])),
      books: new Map(state.pool.books.map((t, position) => [keyOf(t), position])),
    }
    return state.positions
  }

  function resolve(key: TxnKey): Transaction | undefined {
    const parsed = parseTxnKey(key)
    if (!parsed || !normalized) return undefined
    const position = positions(normalized)[parsed.side].get(key)
    return position === undefined ? undefined : normalized.pool[parsed.side][position]
  }

  function position(t: Transaction): number {
    return positions(normalized as Normalized)[t.side].get(keyOf(t)) as number
  }

  // A key's file is loaded: the side's source file, or an imported opening-items file.
  function sourcePresent(key: TxnKey): boolean {
    const parsed = parseTxnKey(key)
    if (!parsed) return false
    return sources[parsed.side]?.fingerprint === parsed.fingerprint || opening.some((o) => o.fingerprint === parsed.fingerprint)
  }

  function replayData(rules: MatchingRules): ReplayData {
    return {
      transaction: resolve,
      // A pair that meets every rule is a suggestion, whether or not a budget-limited search listed it.
      isCandidate: (bank, books) => {
        const pair = checkPair(resolve(bank), resolve(books), rules)
        return pair.blocked === null && pair.exceptions.length === 0
      },
      sourcePresent,
      rules,
    }
  }

  function currentReview(matchId: number) {
    if (!latest || !normalized) throw new Error('Find suggestions first')
    if (matchId !== latest.matchId || latest.revision !== normalized.revision) throw new Error('These suggestions were replaced by a newer run')
    review ??= { matchId, events: [], replay: replay([], replayData(latest.rules)), version: 0, used: { bank: new Uint8Array(0), books: new Uint8Array(0) }, rejected: new Set(), counts: null }
    return { latest, normalized, review }
  }

  // Positions used by active matches and rejected position pairs, for fast filtering.
  function derive(state: NonNullable<typeof review>, data: Normalized) {
    const used = { bank: new Uint8Array(data.pool.bank.length), books: new Uint8Array(data.pool.books.length) }
    for (const event of state.replay.state.active.values()) {
      used.bank[position(resolve(event.bank) as Transaction)] = 1
      used.books[position(resolve(event.books) as Transaction)] = 1
    }
    const rejected = new Set<string>()
    for (const event of state.replay.state.rejected.values()) {
      const bank = resolve(event.bank)
      const books = resolve(event.books)
      if (bank && books) rejected.add(`${position(bank)}:${position(books)}`)
    }
    state.used = used
    state.rejected = rejected
    state.counts = null
    state.version++
  }

  function available(state: NonNullable<typeof review>) {
    return (c: { bank: number; books: number }) => !state.used.bank[c.bank] && !state.used.books[c.books] && !state.rejected.has(`${c.bank}:${c.books}`)
  }

  function counts(state: NonNullable<typeof review>, outcome: MatchOutcome, data: Normalized): Record<ReconSide, Int32Array> {
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

  function summary(state: NonNullable<typeof review>, outcome: MatchOutcome): DecisionSummary {
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

  function snapshot(key: TxnKey): TransactionSnapshot | null {
    const t = resolve(key)
    if (!t || !normalized) return null
    const description = normalized.mappings[t.side].description
    return {
      key,
      date: isoDate(t.day),
      amount: formatDecimal(t.amount),
      direction: t.amount.units > 0n ? 'in' : 'out',
      reference: t.reference,
      description: t.opening ? (openingItem(t) as OutstandingItem).description : description === null ? null : (sources[t.side] as Source).file.rows[t.index][description],
    }
  }

  function setDecisions({ matchId, events }: ReconRequests['setDecisions']): ReconResults['setDecisions'] {
    const { latest: run, normalized: data, review: state } = currentReview(matchId)
    state.events = [...events]
    state.replay = replay(state.events, replayData(run.rules))
    derive(state, data)
    return summary(state, run.outcome)
  }

  function suggestionItem(outcome: MatchOutcome, data: Normalized, c: Candidate): SuggestionItem {
    const group = outcome.groups[c.group]
    return {
      group: c.group,
      groupBank: group.bank.length,
      groupBooks: group.books.length,
      groupPairs: group.pairs,
      unique: group.unique,
      tier: c.tier,
      gap: c.gap,
      bank: view(data.pool.bank[c.bank], data.mappings.bank),
      books: view(data.pool.books[c.books], data.mappings.books),
      set: setKind(outcome, data, c.group),
    }
  }

  function descriptionOf(data: Normalized, t: Transaction): string {
    const carried = openingItem(t)
    if (carried) return (carried.description ?? '').trim()
    const column = data.mappings[t.side].description
    return column === null ? '' : (sources[t.side] as Source).file.rows[t.index][column].trim()
  }

  function setKind(outcome: MatchOutcome, data: Normalized, groupId: number): SetKind | null {
    const cached = setKinds.get(groupId)
    if (cached !== undefined) return cached
    const group = outcome.groups[groupId]
    let kind: SetKind | null = null
    if (!group.unique) {
      const same = (side: ReconSide, positions: number[]) => {
        const all = positions.map((p) => data.pool[side][p])
        const first = all[0]
        const fields = all.every((t) => t.day === first.day && t.amount.units === first.amount.units && t.reference === first.reference)
        const descriptions = all.every((t) => descriptionOf(data, t) === descriptionOf(data, first))
        return { fields, descriptions }
      }
      const bank = same('bank', group.bank)
      const books = same('books', group.books)
      if (bank.fields && books.fields) kind = bank.descriptions && books.descriptions ? 'interchangeable' : 'different-descriptions'
    }
    setKinds.set(groupId, kind)
    return kind
  }

  function getSet({ matchId, group }: ReconRequests['getSet']): ReconResults['getSet'] {
    const { latest: run, normalized: data, review: state } = currentReview(matchId)
    const kind = setKind(run.outcome, data, group)
    if (kind === null) throw new Error('This group is not a set of identical transactions')
    const members = run.outcome.groups[group]
    const open = (side: ReconSide, positions: number[]) =>
      positions
        .filter((p) => !state.used[side][p])
        .map((p) => data.pool[side][p])
        .sort((a, b) => a.index - b.index)
    const bank = open('bank', members.bank)
    const books = open('books', members.books)
    const rejectedInside = bank.some((b) => books.some((l) => state.rejected.has(`${position(b)}:${position(l)}`)))
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
      bank: bank.map((t) => view(t, data.mappings.bank)),
      books: books.map((t) => view(t, data.mappings.books)),
      blocked,
    }
  }

  function decideSet({ matchId, group, seq, at, pairs }: ReconRequests['decideSet']): ReconResults['decideSet'] {
    const { latest: run, normalized: data, review: state } = currentReview(matchId)
    if (seq !== state.events.length + 1) throw new Error('The decision history is out of step with this session; reload the session')
    const set = getSet({ matchId, group })
    if (set.blocked) return { ok: false, reason: set.blocked }
    if (pairs.length === 0) return { ok: false, reason: 'Choose at least one pair' }
    const bankKeys = new Set(set.bank.map((v) => v.key))
    const booksKeys = new Set(set.books.map((v) => v.key))
    if (!pairs.every((p) => bankKeys.has(p.bank) && booksKeys.has(p.books))) return { ok: false, reason: 'Every pair must come from this set' }
    // Check every pair against a copy first, so a failure leaves the history untouched.
    const trial: DecisionState = {
      bankMatch: new Map(state.replay.state.bankMatch),
      booksMatch: new Map(state.replay.state.booksMatch),
      active: new Map(state.replay.state.active),
      rejected: new Map(state.replay.state.rejected),
      classifications: new Map(state.replay.state.classifications),
      completion: state.replay.state.completion,
      lastSeq: state.replay.state.lastSeq,
    }
    const data_ = replayData(run.rules)
    const events: PairEvent[] = []
    for (const [i, pair] of pairs.entries()) {
      const decision = { action: 'confirm' as const, ...pair, origin: 'set' as const }
      const verdict = checkDecision(trial, decision, data_)
      if (!verdict.ok) return verdict
      const event: PairEvent = { seq: seq + i, at, ...decision }
      applyToState(trial, event)
      events.push(event)
    }
    for (const event of events) {
      state.events.push(event)
      applyToState(state.replay.state, event)
    }
    derive(state, data)
    const snapshots = events.flatMap((e) => [snapshot(e.bank), snapshot(e.books)]).filter((s): s is TransactionSnapshot => s !== null)
    return { ok: true, events, snapshots, summary: summary(state, run.outcome) }
  }

  // Balance text as typed, in cash terms; errors name what could not be read.
  function statedBalances(setup: AccountingSetup, minorUnits: number) {
    const errors: string[] = []
    const read = (side: ReconSide, field: 'opening' | 'closing'): Decimal | null => {
      const text = setup.balances[side][field]
      if (text === null || text.trim() === '') return null
      const value = parseDecimal(text.trim(), { grouped: true })
      const scaled = value && toScale(value, minorUnits)
      if (!scaled) {
        errors.push(`${side === 'bank' ? 'Bank' : 'Books'} ${field} balance "${text}" is not an amount with at most ${minorUnits} decimal places`)
        return null
      }
      return cashBalance(scaled, setup.balances[side].basis)
    }
    const balances = {
      bank: { opening: read('bank', 'opening'), closing: read('bank', 'closing') },
      books: { opening: read('books', 'opening'), closing: read('books', 'closing') },
    }
    return { balances, errors }
  }

  // Walks the side's rows in file order; a row without a valid amount stops the check.
  function runningBalance(data: Normalized, side: ReconSide, opening: Decimal | null, basis: BalanceBasis): RunningBalanceCheck | null {
    const column = data.mappings[side].balance
    if (column === null || opening === null) return null
    const { minorUnits } = data.context
    const amounts = new Map(data.sides[side].transactions.map((t) => [t.index, t.amount]))
    const zero = new Set(data.sides[side].zero)
    const rows = (sources[side] as Source).file.rows.map((row, index) => {
      const amount = amounts.get(index) ?? (zero.has(index) ? { units: 0n, scale: minorUnits } : null)
      const parsed = parseDecimal(row[column].trim(), data.mappings[side].amountFormat)
      const scaled = parsed && toScale(parsed, minorUnits)
      return { amount, balance: scaled ? cashBalance(scaled, basis) : null }
    })
    return checkRunningBalance(opening, rows)
  }

  function runningIssue(side: ReconSide, check: RunningBalanceCheck | null): string | null {
    const name = side === 'bank' ? 'Bank' : 'Books'
    if (check?.status === 'break') {
      return `${name}: the running balance breaks at record ${check.first.row} (expected ${formatDecimal(check.first.expected)}, found ${formatDecimal(check.first.found)})`
    }
    if (check?.status === 'unreadable') return `${name}: the running balance can't be checked past record ${check.row}`
    return null
  }

  function report(run: NonNullable<typeof latest>, data: Normalized, state: NonNullable<typeof review>, setup: AccountingSetup, basis: string): AccountingReport {
    const { balances, errors } = statedBalances(setup, data.context.minorUnits)
    const amounts = (ts: Transaction[]) => ts.map((t) => t.amount)
    const unmatched = (side: ReconSide) => data.pool[side].filter((t, p) => !t.opening && !state.used[side][p])
    const openingAll = (side: ReconSide) => data.pool[side].filter((t) => t.opening)
    const openingRemaining = (side: ReconSide) => data.pool[side].filter((t, p) => t.opening && !state.used[side][p])
    const invalid = (side: ReconSide) => new Set(data.sides[side].problems.map((p) => p.index)).size
    const movement = { bank: sum(amounts(data.sides.bank.transactions)), books: sum(amounts(data.sides.books.transactions)) }
    const confirmed = [...state.replay.state.active.values()]
    const differences = confirmed.map((event) => subtractDecimal((resolve(event.bank) as Transaction).amount, (resolve(event.books) as Transaction).amount))
    const bridge = computeBridge({
      sides: {
        bank: { balances: balances.bank, movement: movement.bank, invalidRows: invalid('bank') },
        books: { balances: balances.books, movement: movement.books, invalidRows: invalid('books') },
      },
      openingAll: { bank: amounts(openingAll('bank')), books: amounts(openingAll('books')) },
      openingRemaining: { bank: amounts(openingRemaining('bank')), books: amounts(openingRemaining('books')) },
      unmatched: { bank: amounts(unmatched('bank')), books: amounts(unmatched('books')) },
      confirmedDifferences: differences,
      incompleteSearch: run.outcome.incomplete !== null,
    })
    const classifications = state.replay.state.classifications
    // Remaining opening items need a classification as much as unmatched movements do.
    const unclassified = RECON_SIDES.reduce((n, side) => n + [...unmatched(side), ...openingRemaining(side)].filter((t) => !classifications.has(keyOf(t))).length, 0)
    const completion = state.replay.state.completion
    const running = {
      bank: runningBalance(data, 'bank', balances.bank.opening, setup.balances.bank.basis),
      books: runningBalance(data, 'books', balances.books.opening, setup.balances.books.basis),
    }
    const facts: ReviewFacts = {
      unclassified,
      problems: invalid('bank') + invalid('books'),
      sourceIssues: RECON_SIDES.map((side) => runningIssue(side, running[side])).filter((issue): issue is string => issue !== null),
      unexplainedVariances: confirmed.filter((event, i) => differences[i].units !== 0n && !event.reason?.trim()).length,
      completion: { marked: completion !== null, current: completion !== null && completion.seq === state.replay.state.lastSeq && completion.basis === basis },
    }
    return { bridge, statuses: computeStatuses(bridge, facts), balances, balanceErrors: errors, movement, facts, running }
  }

  function exportOutstanding({ matchId, sessionId, period, exportedAt }: ReconRequests['exportOutstanding']): ReconResults['exportOutstanding'] {
    const { normalized: data, review: state } = currentReview(matchId)
    const outstanding: OutstandingSource[] = []
    const cleared: string[] = []
    for (const side of RECON_SIDES) {
      data.pool[side].forEach((t, p) => {
        const carried = openingItem(t)
        if (state.used[side][p]) {
          if (carried) cleared.push(carried.lineage)
          return
        }
        const source = sources[side] as Source
        outstanding.push({
          transaction: t,
          description: carried ? carried.description : descriptionOf(data, t) || null,
          carried,
          provenance: carried ? carried.origin : { sessionId, period, fileName: source.name, fingerprint: source.fingerprint, recordNumber: t.index + 1 },
        })
      })
    }
    // Clearances inherited from imported files travel on, so a later period can still refuse
    // a stale file that lists one of them as outstanding.
    const allCleared = [...new Set([...opening.flatMap((o) => o.file.cleared), ...cleared])]
    const file = buildOutstandingFile({ sessionId, context: data.context, period, outstanding, cleared: allCleared, exportedAt })
    return { text: JSON.stringify(file, null, 2), items: file.items.length, cleared: allCleared.length }
  }

  function reportTransaction(t: Transaction, mapping: SideMapping): ReportTransaction {
    const v = view(t, mapping)
    return {
      key: v.key,
      side: v.side,
      location: placeLabel(v, (sources[v.side] as Source).file.format.kind),
      date: v.date,
      amount: v.amount,
      direction: v.direction,
      reference: v.reference,
      description: v.original.description,
      carried: v.carried ?? null,
    }
  }

  function runningText(check: RunningBalanceCheck | null): string | null {
    if (!check) return null
    if (check.status === 'consistent') return 'consistent with every row'
    if (check.status === 'break') return `breaks at record ${check.first.row}: expected ${formatDecimal(check.first.expected)}, found ${formatDecimal(check.first.found)}`
    return `can't be checked past record ${check.row}`
  }

  function buildReport({ matchId, setup, basis, session, generatedAt }: ReconRequests['exportReport']): ReconciliationReport {
    const { latest: run, normalized: data, review: state } = currentReview(matchId)
    const accountingReport = report(run, data, state, setup, basis)
    const kind = (side: ReconSide) => (sources[side] as Source).file.format.kind
    const matches: ReportMatch[] = [...state.replay.state.active.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((event) => {
        const bank = resolve(event.bank) as Transaction
        const books = resolve(event.books) as Transaction
        const { tier, gap } = evidence(bank, books, run.rules)
        return {
          decision: event.seq,
          at: event.at,
          origin: event.origin ?? 'suggested',
          bank: reportTransaction(bank, data.mappings.bank),
          books: reportTransaction(books, data.mappings.books),
          variance: formatDecimal(subtractDecimal(bank.amount, books.amount)),
          dateGap: gap,
          tier,
          exceptions: event.exceptions ?? [],
          reason: event.reason ?? null,
        }
      })
    const classifications = state.replay.state.classifications
    const outstanding: ReportOutstanding[] = RECON_SIDES.flatMap((side) =>
      data.pool[side]
        .filter((_, p) => !state.used[side][p])
        .map((t) => {
          const classified = classifications.get(keyOf(t))
          return { transaction: reportTransaction(t, data.mappings[side]), classification: classified?.classification ?? null, note: classified?.note ?? null }
        }),
    )
    const problems: ReportProblem[] = problemRows(data).map((p) => ({
      side: p.side,
      location: placeLabel(p, kind(p.side)),
      kind: p.kind,
      messages: p.messages,
      original: p.original,
    }))
    const text = (d: Decimal | null) => (d === null ? null : formatDecimal(d))
    const sourceEntry = (side: ReconSide) => {
      const { file, fingerprint, name } = sources[side] as Source
      return { fileName: name, fingerprint, sheet: file.format.kind === 'xlsx' ? file.format.sheet : null, recordCount: file.rows.length }
    }
    const { bridge, statuses, balances } = accountingReport
    const counts = (side: ReconSide) => ({
      rows: (sources[side] as Source).file.rows.length,
      valid: data.sides[side].transactions.length,
      invalid: new Set(data.sides[side].problems.map((p) => p.index)).size,
      zero: data.sides[side].zero.length,
      opening: data.pool[side].length - data.sides[side].transactions.length,
    })
    return {
      format: REPORT_FORMAT,
      version: REPORT_VERSION,
      generatedAt,
      experimental: true,
      session,
      account: data.context.account,
      currency: data.context.currency,
      minorUnits: data.context.minorUnits,
      period: setup.period,
      sources: { bank: sourceEntry('bank'), books: sourceEntry('books') },
      opening: opening.map((o) => ({ fileName: o.name, fingerprint: o.fingerprint, period: o.file.period, items: o.file.items.length, cleared: o.file.cleared.length })),
      mappings: data.mappings,
      rules: run.rules,
      counts: { bank: counts('bank'), books: counts('books') },
      balances: {
        stated: setup.balances,
        cash: {
          bank: { opening: text(balances.bank.opening), closing: text(balances.bank.closing) },
          books: { opening: text(balances.books.opening), closing: text(balances.books.closing) },
        },
      },
      running: { bank: runningText(accountingReport.running.bank), books: runningText(accountingReport.running.books) },
      statuses: {
        sourcesValidated: statuses.sourcesValidated,
        bridgeComplete: statuses.bridgeComplete,
        outstandingReviewed: statuses.outstandingReviewed,
        completed: statuses.completed,
      },
      bridge: { closingDifference: text(bridge.actual), explained: formatDecimal(bridge.explained), unexplained: text(bridge.unexplained), complete: bridge.complete, gaps: bridge.gaps },
      search: { candidatePairs: run.outcome.candidates.length, groups: run.outcome.groups.length, incomplete: run.outcome.incomplete, referenceConflicts: run.outcome.referenceConflicts },
      matches,
      outstanding,
      problems,
      decisions: state.events,
      lapsed: state.replay.lapsed.map(({ event, reason }) => ({ decision: event.seq, reason })),
    }
  }

  async function exportReport(request: ReconRequests['exportReport']): Promise<ReconResults['exportReport']> {
    const built = buildReport(request)
    if (request.format === 'json') return new Blob([reportJson(built)], { type: 'application/json' })
    const { writeWorkbook, MAX_CELL_CHARS, MAX_SHEET_COLUMNS, MAX_SHEET_ROWS } = await import('../engine/xlsx-report')
    const bytes = writeWorkbook(
      reportTables(built),
      { maxSheetRows: MAX_SHEET_ROWS, maxSheetColumns: MAX_SHEET_COLUMNS, maxCellChars: MAX_CELL_CHARS, maxCells: limits.maxXlsxExportCells, maxTextChars: limits.maxXlsxExportText },
      'Download the JSON report instead; it has no such limit.',
    )
    return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  }

  function accounting({ matchId, setup, basis }: ReconRequests['accounting']): ReconResults['accounting'] {
    const { latest: run, normalized: data, review: state } = currentReview(matchId)
    return report(run, data, state, setup, basis)
  }

  function markComplete({ matchId, seq, at, setup, basis }: ReconRequests['markComplete']): ReconResults['markComplete'] {
    const { latest: run, normalized: data, review: state } = currentReview(matchId)
    if (seq !== state.events.length + 1) throw new Error('The decision history is out of step with this session; reload the session')
    const before = report(run, data, state, setup, basis)
    if (!before.statuses.canMarkComplete) {
      const reasons = [before.statuses.sourcesValidated, before.statuses.bridgeComplete, before.statuses.outstandingReviewed].flatMap((s) => s.reasons)
      return { ok: false, reason: `Not ready to mark complete: ${[...reasons, ...before.statuses.completed.reasons.filter((r) => r !== 'Not marked complete' && !r.startsWith('Marked complete'))].filter((r, i, all) => all.indexOf(r) === i).join('; ')}` }
    }
    const event: DecisionEvent = { seq, at, action: 'complete', basis }
    state.events.push(event)
    applyToState(state.replay.state, event)
    return { ok: true, event, report: report(run, data, state, setup, basis) }
  }

  const ALTERNATIVES = 20

  function inspect({ matchId, keys }: ReconRequests['inspect']): ReconResults['inspect'] {
    const { latest: run, normalized: data, review: state } = currentReview(matchId)
    const ok = available(state)
    return keys.map((key) => {
      const t = resolve(key)
      if (!t) return null
      const carried = openingItem(t)
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
            const file = (sources[t.side] as Source).file
            return { headers: file.headers, values: file.headers.map((h) => file.rows[t.index][h]) }
          })()
      const own = position(t)
      const otherSide: ReconSide = t.side === 'bank' ? 'books' : 'bank'
      const partnerKey = t.side === 'bank' ? state.replay.state.bankMatch.get(key) : state.replay.state.booksMatch.get(key)
      const partner = partnerKey ? resolve(partnerKey) : undefined
      const event = partnerKey ? state.replay.state.active.get(t.side === 'bank' ? edgeKey(key, partnerKey) : edgeKey(partnerKey, key)) : undefined
      const involving = run.outcome.candidates.filter((c) => (t.side === 'bank' ? c.bank : c.books) === own && ok(c))
      let rejectedPairs = 0
      for (const e of state.replay.state.rejected.values()) if (e.bank === key || e.books === key) rejectedPairs++
      return {
        view: view(t, data.mappings[t.side]),
        ...row,
        match: partner && event ? { other: view(partner, data.mappings[otherSide]), event } : null,
        alternatives: involving.slice(0, ALTERNATIVES).map((c) => suggestionItem(run.outcome, data, c)),
        alternativesTotal: involving.length,
        rejectedPairs,
      }
    })
  }

  function decide({ matchId, seq, at, decision }: ReconRequests['decide']): ReconResults['decide'] {
    const { latest: run, normalized: data, review: state } = currentReview(matchId)
    if (seq !== state.events.length + 1) throw new Error('The decision history is out of step with this session; reload the session')
    // Mark-complete needs the balances and statuses; it goes through markComplete.
    if (decision.action === 'complete') throw new Error('Mark complete through the completion check')
    const verdict = checkDecision(state.replay.state, decision, replayData(run.rules))
    if (!verdict.ok) return verdict
    const event = { seq, at, ...decision } as DecisionEvent
    state.events.push(event)
    applyToState(state.replay.state, event)
    derive(state, data)
    const snapshots = eventKeys(event).map(snapshot).filter((s): s is TransactionSnapshot => s !== null)
    return { ok: true, event, snapshots, summary: summary(state, run.outcome) }
  }

  function pairCheck({ matchId, bank, books }: ReconRequests['checkPair']): ReconResults['checkPair'] {
    const { latest: run, normalized: data, review: state } = currentReview(matchId)
    const b = resolve(bank)
    const l = resolve(books)
    const pair = checkPair(b, l, run.rules)
    const structural = structuralCheck(state.replay.state, { action: 'confirm', bank, books })
    return {
      blocked: pair.blocked ?? (structural.ok ? null : structural.reason),
      exceptions: pair.exceptions,
      bank: b ? view(b, data.mappings.bank) : null,
      books: l ? view(l, data.mappings.books) : null,
    }
  }

  function evidence(bank: Transaction, books: Transaction, rules: MatchingRules): { tier: Tier | null; gap: number } {
    const gap = bank.day - books.day
    const pair = checkPair(bank, books, rules)
    if (pair.blocked !== null || pair.exceptions.length > 0) return { tier: null, gap }
    return { tier: rules.referencesShared && bank.reference !== null && books.reference !== null ? 1 : 3, gap }
  }

  function getReview({ matchId, tab, offset, limit, search, direction }: ReconRequests['getReview']): ReconResults['getReview'] {
    const { latest: run, normalized: data, review: state } = currentReview(matchId)
    const { outcome } = run
    const { pool, mappings } = data
    const [start, end] = pageBounds(offset, limit)
    const needle = normaliseSearch(search)
    const filtered = <T,>(build: () => T[], keep: (item: T) => boolean): T[] =>
      searchCache.get(`${matchId}\u0000${state.version}\u0000${tab}\u0000${direction ?? ''}\u0000${needle}`, () =>
        needle === '' && direction === undefined ? build() : build().filter(keep),
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
            (needle === '' || searchText(data, 'bank', c.bank).includes(needle) || searchText(data, 'books', c.books).includes(needle)),
        )
        const items = all.slice(start, end).map((c) => suggestionItem(run.outcome, data, c))
        return { tab, total: all.length, offset: start, items }
      }
      case 'confirmed': {
        const confirmed = (): ConfirmedItem[] =>
          [...state.replay.state.active.values()]
            .sort((a, b) => a.seq - b.seq)
            .map((event) => {
              const bank = resolve(event.bank) as Transaction
              const books = resolve(event.books) as Transaction
              return { bank: view(bank, mappings.bank), books: view(books, mappings.books), event, ...evidence(bank, books, run.rules) }
            })
        const all = filtered(confirmed, (item) => isDirection(item.bank.direction) && (needle === '' || matches([...both(item.bank, item.books), item.event.reason ?? ''], needle)))
        return { tab, total: all.length, offset: start, items: all.slice(start, end) }
      }
      case 'unmatched': {
        const per = counts(state, outcome, data)
        const all = filtered(
          () => RECON_SIDES.flatMap((side) => pool[side].filter((_, p) => !state.used[side][p])),
          (t) => isDirection(directionOf(t)) && (needle === '' || searchText(data, t.side, position(t)).includes(needle)),
        )
        const items = all.slice(start, end).map((t): UnmatchedItem => {
          const v = view(t, mappings[t.side])
          const classified = state.replay.state.classifications.get(v.key)
          const classification = classified?.classification ? { value: classified.classification, note: classified.note ?? null } : null
          return { ...v, suggestions: per[t.side][position(t)], classification }
        })
        return { tab, total: all.length, offset: start, items }
      }
      case 'rejected': {
        const rejected = (): RejectedItem[] =>
          [...state.replay.state.rejected.values()]
            .sort((a, b) => a.seq - b.seq)
            .map((event) => {
              const bank = resolve(event.bank)
              const books = resolve(event.books)
              return {
                bankKey: event.bank,
                booksKey: event.books,
                bank: bank ? view(bank, mappings.bank) : null,
                books: books ? view(books, mappings.books) : null,
                event,
              }
            })
        const all = filtered(rejected, (item) => (item.bank === null || isDirection(item.bank.direction)) && (needle === '' || matches(both(item.bank, item.books), needle)))
        return { tab, total: all.length, offset: start, items: all.slice(start, end) }
      }
      case 'problems': {
        const all = filtered(
          () => problemRows(data),
          // Problem rows have no trustworthy direction, so the direction filter does not apply.
          (p) => matches([...p.messages, p.original.date, ...p.original.amount, p.original.reference ?? '', p.original.description ?? ''], needle),
        )
        return { tab, total: all.length, offset: start, items: all.slice(start, end) }
      }
    }
  }

  return async function handle(request: ReconRequest, onProgress?: Reporter): Promise<ReconResults[ReconRequest['type']]> {
    switch (request.type) {
      case 'parse':
        return parse(request, onProgress)
      case 'getIssues':
        return getIssues(request)
      case 'normalize':
        return normalize(request, onProgress)
      case 'match':
        return match(request, onProgress)
      case 'getReview':
        return getReview(request)
      case 'setDecisions':
        return setDecisions(request)
      case 'decide':
        return decide(request)
      case 'checkPair':
        return pairCheck(request)
      case 'getSet':
        return getSet(request)
      case 'decideSet':
        return decideSet(request)
      case 'inspect':
        return inspect(request)
      case 'accounting':
        return accounting(request)
      case 'markComplete':
        return markComplete(request)
      case 'setOpening':
        return setOpening(request)
      case 'exportOutstanding':
        return exportOutstanding(request)
      case 'exportReport':
        return exportReport(request)
    }
  }
}
