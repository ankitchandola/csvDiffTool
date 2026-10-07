import { formatDecimal } from '../engine/decimal'
import { DEFAULT_LIMITS, type Limits } from '../engine/limits'
import type { ParseIssue } from '../engine/parse'
import type { ParsedFile } from '../engine/types'
import { isoDate } from '../reconciliation/dates'
import { findCandidates, type MatchOutcome } from '../reconciliation/match'
import { contextIssues, mappingIssues, normalizeSide } from '../reconciliation/normalize'
import {
  type Direction,
  type NormalizationProblem,
  type NormalizedSide,
  RECON_SIDES,
  type ReconSide,
  type SideMapping,
  type Transaction,
} from '../reconciliation/types'
import { MAX_PAGE_SIZE, type Preview, PREVIEW_ISSUES, PREVIEW_RECORDS } from './protocol'
import { readSource } from './read-source'
import {
  type Location,
  type OriginalValues,
  PREVIEW_SKIPPED,
  type ProblemItem,
  type ReconPhase,
  type ReconRequest,
  type ReconRequests,
  type ReconResults,
  SAMPLE_ROWS,
  type SampleRow,
  type SideSummary,
  type SuggestionItem,
  type TransactionView,
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
}

interface Normalized {
  revision: number
  mappings: Record<ReconSide, SideMapping>
  sides: Record<ReconSide, NormalizedSide>
  // Problems grouped per source row, in row order, with zero-value rows interleaved.
  problemRows: ProblemItem[] | null
}

// Owns parsed sources, normalized transactions and the latest suggestions, so full data
// never crosses to the UI thread. Every parse or normalization starts a new revision; a
// match or page request for an older revision is rejected rather than served newer data.
export function createReconcileHandler(limits: Limits = DEFAULT_LIMITS) {
  const sources: Partial<Record<ReconSide, Source>> = {}
  const issues: Partial<Record<ReconSide, ParseIssue[]>> = {}
  const generations: Record<ReconSide, number> = { bank: 0, books: 0 }
  let revision = 0
  let normalized: Normalized | null = null
  let latest: { matchId: number; revision: number; outcome: MatchOutcome } | null = null
  let nextMatchId = 1
  const searchCache = createSearchCache()

  function invalidate() {
    revision++
    normalized = null
    latest = null
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
    sources[side] = { file: outcome.file, fingerprint }
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

  function view(t: Transaction, mapping: SideMapping): TransactionView {
    return {
      ...location(t.side, t.index),
      date: isoDate(t.day),
      amount: formatDecimal(t.amount),
      direction: t.amount.units > 0n ? 'in' : 'out',
      reference: t.reference,
      original: original(t.side, t.index, mapping),
    }
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

  function normalize({ context, mappings }: ReconRequests['normalize'], onProgress?: Reporter): ReconResults['normalize'] {
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
    normalized = { revision, mappings, sides, problemRows: null }
    return {
      ok: true,
      revision,
      sides: { bank: summarize('bank', sides.bank, mappings.bank), books: summarize('books', sides.books, mappings.books) },
    }
  }

  function current(forRevision: number): Normalized {
    if (normalized?.revision !== forRevision) throw new Error('The files or mappings changed; check the mapping again')
    return normalized
  }

  function match({ revision: forRevision, rules }: ReconRequests['match'], onProgress?: Reporter): ReconResults['match'] {
    const { sides } = current(forRevision)
    latest = null
    onProgress?.('match', 0, 1)
    const outcome = findCandidates(sides.bank.transactions, sides.books.transactions, rules)
    onProgress?.('match', 1, 1)
    const matchId = nextMatchId++
    latest = { matchId, revision: forRevision, outcome }
    const per = (count: (side: ReconSide) => number) => ({ bank: count('bank'), books: count('books') })
    return {
      matchId,
      revision: forRevision,
      rules,
      pairs: outcome.candidates.length,
      groups: outcome.groups.length,
      uniqueGroups: outcome.groups.filter((g) => g.unique).length,
      withCandidates: per((side) => sides[side].transactions.length - outcome.noCandidate[side].length),
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

  function getReview({ matchId, tab, offset, limit, search, direction }: ReconRequests['getReview']): ReconResults['getReview'] {
    if (!latest || !normalized) throw new Error('Find suggestions first')
    if (matchId !== latest.matchId || latest.revision !== normalized.revision) throw new Error('These suggestions were replaced by a newer run')
    const { outcome } = latest
    const { sides, mappings } = normalized
    const [start, end] = pageBounds(offset, limit)
    const needle = normaliseSearch(search)
    const filtered = <T,>(build: () => T[], keep: (item: T) => boolean): T[] =>
      needle === '' && direction === undefined
        ? build()
        : searchCache.get(`${matchId}\u0000${tab}\u0000${direction ?? ''}\u0000${needle}`, () => build().filter(keep))
    const isDirection = (d: Direction) => direction === undefined || d === direction

    switch (tab) {
      case 'suggested': {
        const groups = outcome.groups
        const all = filtered(
          () => outcome.candidates,
          (c) => {
            const bank = view(sides.bank.transactions[c.bank], mappings.bank)
            const books = view(sides.books.transactions[c.books], mappings.books)
            return isDirection(bank.direction) && (needle === '' || matches([...texts(bank), ...texts(books)], needle))
          },
        )
        const items = all.slice(start, end).map((c): SuggestionItem => {
          const group = groups[c.group]
          return {
            group: c.group,
            groupBank: group.bank.length,
            groupBooks: group.books.length,
            groupPairs: group.pairs,
            unique: group.unique,
            tier: c.tier,
            gap: c.gap,
            bank: view(sides.bank.transactions[c.bank], mappings.bank),
            books: view(sides.books.transactions[c.books], mappings.books),
          }
        })
        return { tab, total: all.length, offset: start, items }
      }
      case 'unmatched': {
        const all = filtered(
          () => RECON_SIDES.flatMap((side) => outcome.noCandidate[side].map((position) => sides[side].transactions[position])),
          (t) => {
            const v = view(t, mappings[t.side])
            return isDirection(v.direction) && (needle === '' || matches(texts(v), needle))
          },
        )
        return { tab, total: all.length, offset: start, items: all.slice(start, end).map((t) => view(t, mappings[t.side])) }
      }
      case 'problems': {
        const all = filtered(
          () => problemRows(normalized as Normalized),
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
    }
  }
}
