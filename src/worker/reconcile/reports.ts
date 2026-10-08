import { type Decimal, formatDecimal, subtractDecimal } from '../../engine/decimal'
import { type RunningBalanceCheck } from '../../reconciliation/accounting'
import { placeLabel } from '../../reconciliation/location'
import { type ReconciliationReport, REPORT_FORMAT, REPORT_VERSION, reportJson, type ReportMatch, type ReportOutstanding, type ReportProblem, reportTables, type ReportTransaction } from '../../reconciliation/report'
import { RECON_SIDES, type ReconSide, type SideMapping, type Transaction } from '../../reconciliation/types'
import { type ReconRequests, type ReconResults } from '../reconcile-protocol'
import { report } from './accounting'
import { currentReview, evidence, keyOf, problemRows, resolve, type Source, view, type Workspace } from './workspace'

// The reconciliation report, as JSON or an Excel workbook.

export function reportTransaction(ws: Workspace, t: Transaction, mapping: SideMapping): ReportTransaction {
  const v = view(ws, t, mapping)
  return {
    key: v.key,
    side: v.side,
    location: placeLabel(v, (ws.sources[v.side] as Source).file.format.kind),
    date: v.date,
    amount: v.amount,
    direction: v.direction,
    reference: v.reference,
    description: v.original.description,
    carried: v.carried ?? null,
  }
}

export function runningText(check: RunningBalanceCheck | null): string | null {
  if (!check) return null
  if (check.status === 'consistent') return 'consistent with every row'
  if (check.status === 'break') return `breaks at record ${check.first.row}: expected ${formatDecimal(check.first.expected)}, found ${formatDecimal(check.first.found)}`
  return `can't be checked past record ${check.row}`
}

export function buildReport(ws: Workspace, { matchId, setup, basis, session, generatedAt }: ReconRequests['exportReport']): ReconciliationReport {
  const { latest: run, normalized: data, review: state } = currentReview(ws, matchId)
  const accountingReport = report(ws, run, data, state, setup, basis)
  const kind = (side: ReconSide) => (ws.sources[side] as Source).file.format.kind
  const matches: ReportMatch[] = [...state.replay.state.active.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((event) => {
      const bank = resolve(ws, event.bank) as Transaction
      const books = resolve(ws, event.books) as Transaction
      const { tier, gap } = evidence(bank, books, run.rules)
      return {
        decision: event.seq,
        at: event.at,
        origin: event.origin ?? 'suggested',
        bank: reportTransaction(ws, bank, data.mappings.bank),
        books: reportTransaction(ws, books, data.mappings.books),
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
        const classified = classifications.get(keyOf(ws, t))
        return { transaction: reportTransaction(ws, t, data.mappings[side]), classification: classified?.classification ?? null, note: classified?.note ?? null }
      }),
  )
  const problems: ReportProblem[] = problemRows(ws, data).map((p) => ({
    side: p.side,
    location: placeLabel(p, kind(p.side)),
    kind: p.kind,
    messages: p.messages,
    original: p.original,
  }))
  const text = (d: Decimal | null) => (d === null ? null : formatDecimal(d))
  const sourceEntry = (side: ReconSide) => {
    const { file, fingerprint, name } = ws.sources[side] as Source
    return { fileName: name, fingerprint, sheet: file.format.kind === 'xlsx' ? file.format.sheet : null, recordCount: file.rows.length }
  }
  const { bridge, statuses, balances } = accountingReport
  const counts = (side: ReconSide) => ({
    rows: (ws.sources[side] as Source).file.rows.length,
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
    opening: ws.opening.map((o) => ({ fileName: o.name, fingerprint: o.fingerprint, period: o.file.period, items: o.file.items.length, cleared: o.file.cleared.length })),
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

export async function exportReport(ws: Workspace, request: ReconRequests['exportReport']): Promise<ReconResults['exportReport']> {
  const built = buildReport(ws, request)
  if (request.format === 'json') return new Blob([reportJson(built)], { type: 'application/json' })
  const { writeWorkbook, MAX_CELL_CHARS, MAX_SHEET_COLUMNS, MAX_SHEET_ROWS } = await import('../../engine/xlsx-report')
  const bytes = writeWorkbook(
    reportTables(built),
    { maxSheetRows: MAX_SHEET_ROWS, maxSheetColumns: MAX_SHEET_COLUMNS, maxCellChars: MAX_CELL_CHARS, maxCells: ws.limits.maxXlsxExportCells, maxTextChars: ws.limits.maxXlsxExportText },
    'Download the JSON report instead; it has no such limit.',
  )
  return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}
