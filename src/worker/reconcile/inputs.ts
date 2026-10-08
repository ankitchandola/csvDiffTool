import { formatDecimal } from '../../engine/decimal'
import { checkImport, openingTransactions, readOutstandingFile } from '../../reconciliation/carryforward'
import { isoDate } from '../../reconciliation/dates'
import { findCandidates } from '../../reconciliation/match'
import { contextIssues, invalidRowCount, mappingIssues, normalizeSide } from '../../reconciliation/normalize'
import { type NormalizationProblem, type NormalizedSide, RECON_SIDES, type ReconSide, type SideMapping } from '../../reconciliation/types'
import { PREVIEW_ISSUES, PREVIEW_RECORDS } from '../protocol'
import { pageBounds, preview } from '../paging'
import { readSource } from '../read-source'
import { type OpeningOverlap, PREVIEW_SKIPPED, type ReconRequests, type ReconResults, SAMPLE_ROWS, type SampleRow, type SideSummary } from '../reconcile-protocol'
import { current, invalidate, location, type OpeningSource, original, type Reporter, sha256, type Source, type Workspace } from './workspace'

// Reading sources and opening-item files, normalizing them and searching for candidates.

export async function parse(ws: Workspace, { side, file, delimiter, sheet, layout }: ReconRequests['parse'], onProgress?: Reporter): Promise<ReconResults['parse']> {
  delete ws.sources[side]
  delete ws.issues[side]
  invalidate(ws)
  const generation = ++ws.generations[side]
  const { outcome, bytes } = await readSource(
    file,
    { rules: { delimiter, trimHeaders: true }, sheet, layout },
    ws.limits,
    () => generation === ws.generations[side],
    onProgress && ((_, done, total) => onProgress('parse', done, total)),
  )
  if (!outcome.ok) {
    ws.issues[side] = outcome.issues
    return { ok: false, issues: preview(outcome.issues, PREVIEW_ISSUES), ...(outcome.format && { format: outcome.format }) }
  }
  const fingerprint = await sha256(bytes as ArrayBuffer)
  if (generation !== ws.generations[side]) throw new Error('Superseded by a newer file')
  ws.sources[side] = { file: outcome.file, fingerprint, name: file.name }
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
        afterHeader: preview(skipped?.afterHeader ?? [], PREVIEW_SKIPPED),
        after: preview(skipped?.after ?? [], PREVIEW_SKIPPED),
      },
    },
  }
}

export function getIssues(ws: Workspace, { side, offset, limit }: ReconRequests['getIssues']): ReconResults['getIssues'] {
  const all = ws.issues[side] ?? []
  const [start, end] = pageBounds(offset, limit)
  return { side, total: all.length, offset: start, items: all.slice(start, end) }
}

export function summarize(ws: Workspace, side: ReconSide, result: NormalizedSide, mapping: SideMapping): SideSummary {
  const rows = (ws.sources[side] as Source).file.rows.length
  const byIndex = new Map<number, NormalizationProblem[]>()
  for (const problem of result.problems) byIndex.set(problem.index, [...(byIndex.get(problem.index) ?? []), problem])
  const valid = new Map(result.transactions.filter((t) => t.index < SAMPLE_ROWS).map((t) => [t.index, t]))
  const zero = new Set(result.zero)
  const sample: SampleRow[] = []
  for (let index = 0; index < Math.min(rows, SAMPLE_ROWS); index++) {
    const t = valid.get(index)
    sample.push({
      ...location(ws, side, index),
      original: original(ws, side, index, mapping),
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

export async function setOpening(ws: Workspace, { files }: ReconRequests['setOpening']): Promise<ReconResults['setOpening']> {
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
  ws.opening = read
  invalidate(ws)
  return {
    ok: true,
    files: read.map((o) => ({ name: o.name, fingerprint: o.fingerprint, period: o.file.period, account: o.file.account, items: o.file.items.length, cleared: o.file.cleared.length })),
  }
}

export function normalize(ws: Workspace, { context, mappings, period }: ReconRequests['normalize'], onProgress?: Reporter): ReconResults['normalize'] {
  const found: { side: ReconSide | null; message: string }[] = contextIssues(context).map((message) => ({ side: null, message }))
  for (const side of RECON_SIDES) {
    const source = ws.sources[side]
    if (!source) found.push({ side, message: 'Load this file first' })
    else found.push(...mappingIssues(mappings[side], source.file.headers).map((message) => ({ side, message })))
  }
  if (found.length > 0) return { ok: false, issues: found }
  invalidate(ws)
  const sides = {} as Record<ReconSide, NormalizedSide>
  RECON_SIDES.forEach((side, i) => {
    onProgress?.('normalize', i, RECON_SIDES.length)
    sides[side] = normalizeSide(side, (ws.sources[side] as Source).file, mappings[side], context)
  })
  onProgress?.('normalize', RECON_SIDES.length, RECON_SIDES.length)

  // Opening items are checked against this session before they join the pool.
  const current = { bank: sides.bank.transactions, books: sides.books.transactions }
  const imported = new Set<string>()
  const clearedElsewhere = new Set<string>()
  const openingErrors: { side: ReconSide | null; message: string }[] = []
  const warnings: string[] = []
  const overlaps: OpeningOverlap[] = []
  if (ws.opening.length > 0 && !period) openingErrors.push({ side: null, message: 'Enter the period before importing opening items' })
  if (period) {
    for (const o of ws.opening) {
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
  ws.opening.forEach((o, f) => {
    for (const side of RECON_SIDES) {
      pool[side].push(...openingTransactions(o.file, side, context.minorUnits).map((t) => ({ ...t, opening: { file: f, item: t.index } })))
    }
  })
  ws.normalized = { revision: ws.revision, context, mappings, sides, pool, problemRows: null }
  return {
    ok: true,
    revision: ws.revision,
    sides: { bank: summarize(ws, 'bank', sides.bank, mappings.bank), books: summarize(ws, 'books', sides.books, mappings.books) },
    opening: { items: { bank: pool.bank.length - current.bank.length, books: pool.books.length - current.books.length }, warnings, overlaps },
  }
}

export function match(ws: Workspace, { revision: forRevision, rules }: ReconRequests['match'], onProgress?: Reporter): ReconResults['match'] {
  const { pool, sides } = current(ws, forRevision)
  ws.latest = null
  onProgress?.('match', 0, 1)
  const outcome = findCandidates(pool.bank, pool.books, rules)
  onProgress?.('match', 1, 1)
  const matchId = ws.nextMatchId++
  ws.latest = { matchId, revision: forRevision, outcome, rules }
  ws.review = null
  ws.setKinds.clear()
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
    invalid: per((side) => invalidRowCount(sides[side])),
    zero: per((side) => sides[side].zero.length),
    referenceConflicts: outcome.referenceConflicts,
    incomplete: outcome.incomplete,
  }
}
