import type { Table } from '../engine/xlsx-report'
import type { Period } from './carryforward'
import { CLASSIFICATION_LABELS, type Classification, type DecisionEvent, EXCEPTION_LABELS, type RuleException } from './decisions'
import { SIDE_LABELS } from './location'
import type { AccountingSetup } from './session'
import type { Direction, MatchingRules, ReconSide, SideMapping } from './types'

export const REPORT_FORMAT = 'reconciliation-report'
export const REPORT_VERSION = 1

export interface ReportTransaction {
  key: string
  side: ReconSide
  location: string
  date: string
  // Exact decimal text, signed: positive is money in.
  amount: string
  direction: Direction
  reference: string | null
  description: string | null
  // Set for an opening item carried from an earlier period.
  carried: { lineage: string; fileName: string; period: Period } | null
  // Set for a group: a batch, or transactions the reviewer matched together.
  members?: ReportTransaction[]
}

export interface ReportStatus {
  earned: boolean
  reasons: string[]
}

export interface ReportMatch {
  decision: number
  at: string
  origin: 'suggested' | 'manual' | 'set'
  bank: ReportTransaction
  books: ReportTransaction
  // Bank amount minus books amount; "0.00" for an exact match.
  variance: string
  // Bank date minus books date, in days.
  dateGap: number
  // Evidence tier when the pair meets the current rules; null for a manual exception.
  tier: number | null
  exceptions: RuleException[]
  reason: string | null
}

export interface ReportOutstanding {
  transaction: ReportTransaction
  classification: Classification | null
  note: string | null
}

export interface ReportProblem {
  side: ReconSide
  location: string
  kind: 'invalid' | 'zero'
  messages: string[]
  original: { date: string; amount: string[]; reference: string | null; description: string | null }
}

// Everything a reviewer or auditor needs to see what was reconciled and how: provenance,
// rules, balances, statuses, every match with its evidence, what is outstanding, problems
// and the full decision history. Amounts are exact decimal text.
export interface ReconciliationReport {
  format: typeof REPORT_FORMAT
  version: typeof REPORT_VERSION
  generatedAt: string
  // The mode is experimental: this report records review decisions, not an audit opinion.
  experimental: true
  session: { id: string; revision: number }
  account: string
  currency: string
  minorUnits: number
  period: Period | null
  sources: Record<ReconSide, { fileName: string; fingerprint: string; sheet: string | null; recordCount: number }>
  opening: { fileName: string; fingerprint: string; period: Period; items: number; cleared: number }[]
  mappings: Record<ReconSide, SideMapping>
  rules: MatchingRules
  counts: Record<ReconSide, { rows: number; valid: number; invalid: number; zero: number; opening: number }>
  balances: { stated: AccountingSetup['balances']; cash: Record<ReconSide, { opening: string | null; closing: string | null }> }
  running: Record<ReconSide, string | null>
  statuses: { sourcesValidated: ReportStatus; bridgeComplete: ReportStatus; outstandingReviewed: ReportStatus; completed: ReportStatus }
  bridge: { closingDifference: string | null; explained: string; unexplained: string | null; complete: boolean; gaps: string[] }
  search: { candidatePairs: number; groups: number; incomplete: string | null; referenceConflicts: number }
  matches: ReportMatch[]
  outstanding: ReportOutstanding[]
  problems: ReportProblem[]
  decisions: DecisionEvent[]
  lapsed: { decision: number; reason: string }[]
}

export function reportJson(report: ReconciliationReport): string {
  return JSON.stringify(report, null, 2)
}

const yesNo = (status: ReportStatus) => (status.earned ? 'Yes' : `Not yet: ${status.reasons.join('; ')}`)
const text = (value: string | null) => value ?? ''

function transactionColumns(prefix: string): string[] {
  return [`${prefix} location`, `${prefix} date`, `${prefix} amount`, `${prefix} reference`, `${prefix} description`]
}

function transactionCells(t: ReportTransaction): string[] {
  return [t.location, t.date, t.amount, text(t.reference), text(t.description)]
}

function carriedLineages(t: ReportTransaction): string[] {
  return (t.members ?? [t]).map((m) => m.carried?.lineage).filter((l): l is string => l !== undefined)
}

function memberRows(where: string, t: ReportTransaction): string[][] {
  return (t.members ?? []).map((m) => [where, SIDE_LABELS[t.side], t.description ?? '', ...transactionCells(m)])
}

function decisionText(event: DecisionEvent): { what: string; detail: string } {
  if (event.action === 'complete') return { what: 'Marked complete', detail: '' }
  if (event.action === 'classify') {
    return { what: event.classification ? `Classified: ${CLASSIFICATION_LABELS[event.classification]}` : 'Classification cleared', detail: event.note ?? '' }
  }
  const verb = { confirm: 'Confirmed', reject: 'Rejected', restore: 'Restored', unmatch: 'Unmatched' }[event.action]
  const detail = [event.origin ? `origin: ${event.origin}` : '', ...(event.exceptions ?? []).map((e) => EXCEPTION_LABELS[e]), event.reason ? `reason: ${event.reason}` : '']
  return { what: verb, detail: detail.filter(Boolean).join('; ') }
}

// One sheet per section, every cell text, built by the shared writer.
export function reportTables(report: ReconciliationReport): Table[] {
  const byItem = (row: string[]) => `item "${row[0]}"`
  const sides = ['bank', 'books'] as const
  const summary: Table = {
    name: 'Summary',
    header: ['Item', 'Value'],
    describeRow: byItem,
    rows: [
      ['Report', 'Reconciliation (experimental)'],
      ['Generated at', report.generatedAt],
      ['Session', `${report.session.id}, revision ${report.session.revision}`],
      ['Account', report.account],
      ['Currency', `${report.currency} (${report.minorUnits} decimal places)`],
      ['Period', report.period ? `${report.period.start} to ${report.period.end}` : 'not stated'],
      ...sides.flatMap((side) => {
        const source = report.sources[side]
        return [
          [`${SIDE_LABELS[side]} file`, `${source.fileName}${source.sheet ? ` (sheet ${source.sheet})` : ''}`],
          [`${SIDE_LABELS[side]} file SHA-256`, source.fingerprint],
        ]
      }),
      ...report.opening.map((o) => ['Opening items from', `${o.fileName} (${o.period.start} to ${o.period.end}), ${o.items} items, SHA-256 ${o.fingerprint}`]),
      ['Source balances validated', yesNo(report.statuses.sourcesValidated)],
      ['Balance bridge complete', yesNo(report.statuses.bridgeComplete)],
      ['Outstanding items reviewed', yesNo(report.statuses.outstandingReviewed)],
      ['Reconciliation completed', yesNo(report.statuses.completed)],
      ['Closing difference (bank − books)', text(report.bridge.closingDifference)],
      ['Explained by items and variances', report.bridge.explained],
      ['Unexplained', text(report.bridge.unexplained)],
      ...sides.flatMap((side) => {
        const stated = report.balances.stated[side]
        const counts = report.counts[side]
        return [
          [`${SIDE_LABELS[side]} opening balance`, `${text(stated.opening)} (${stated.basis})`],
          [`${SIDE_LABELS[side]} closing balance`, `${text(stated.closing)} (${stated.basis})`],
          [`${SIDE_LABELS[side]} running balance`, report.running[side] ?? 'no running-balance column'],
          [`${SIDE_LABELS[side]} records`, `${counts.rows} records: ${counts.valid} valid, ${counts.invalid} invalid, ${counts.zero} zero; ${counts.opening} opening items`],
        ]
      }),
      ['Candidate search', report.search.incomplete ?? `complete: ${report.search.candidatePairs} candidate pairs in ${report.search.groups} groups`],
      ['Matches confirmed', String(report.matches.length)],
      ['Outstanding items', String(report.outstanding.length)],
      ['Problem records', String(report.problems.length)],
      ['Decisions', String(report.decisions.length)],
      ['Lapsed decisions', String(report.lapsed.length)],
      ['Mappings', JSON.stringify(report.mappings)],
      ['Matching rules', JSON.stringify(report.rules)],
      ['Note', 'Every cell is text. Amounts are exact signed cash flows: positive is money in.'],
      ['Note', 'The mode is experimental. This report records review decisions; it is not an audit opinion.'],
    ],
  }
  const matches: Table = {
    name: 'Matches',
    header: ['Decision', 'Confirmed at', 'Origin', ...transactionColumns('Bank'), ...transactionColumns('Books'), 'Variance', 'Date gap (days)', 'Tier', 'Exceptions', 'Reason', 'Carried lineage'],
    describeRow: (row) => `decision ${row[0]}`,
    rows: report.matches.map((m) => [
      String(m.decision),
      m.at,
      m.origin,
      ...transactionCells(m.bank),
      ...transactionCells(m.books),
      m.variance,
      String(m.dateGap),
      m.tier === null ? 'manual exception' : String(m.tier),
      m.exceptions.map((e) => EXCEPTION_LABELS[e]).join('; '),
      text(m.reason),
      [...carriedLineages(m.bank), ...carriedLineages(m.books)].join('; '),
    ]),
  }
  const outstanding: Table = {
    name: 'Outstanding',
    header: ['Side', ...transactionColumns('Item'), 'Classification', 'Note', 'Carried lineage'],
    describeRow: (row) => row[1],
    rows: report.outstanding.map((o) => [
      SIDE_LABELS[o.transaction.side],
      ...transactionCells(o.transaction),
      o.classification ? CLASSIFICATION_LABELS[o.classification] : 'Not classified',
      text(o.note),
      carriedLineages(o.transaction).join('; '),
    ]),
  }
  const members: Table = {
    name: 'Group members',
    header: ['In', 'Side', 'Group', ...transactionColumns('Member')],
    describeRow: (row) => `${row[0]} member ${row[3]}`,
    rows: [
      ...report.matches.flatMap((m) => [...memberRows(`Decision ${m.decision}`, m.bank), ...memberRows(`Decision ${m.decision}`, m.books)]),
      ...report.outstanding.flatMap((o) => memberRows('Outstanding', o.transaction)),
    ],
  }
  const problems: Table = {
    name: 'Problems',
    header: ['Side', 'Location', 'Kind', 'Messages', 'Date as written', 'Amount as written', 'Reference', 'Description'],
    describeRow: (row) => row[1],
    rows: report.problems.map((p) => [
      SIDE_LABELS[p.side],
      p.location,
      p.kind,
      p.messages.join('; '),
      p.original.date,
      p.original.amount.join(' / '),
      text(p.original.reference),
      text(p.original.description),
    ]),
  }
  const decisions: Table = {
    name: 'Decisions',
    header: ['Decision', 'At', 'Action', 'Transactions', 'Details', 'Lapsed'],
    describeRow: (row) => `decision ${row[0]}`,
    rows: report.decisions.map((event) => {
      const { what, detail } = decisionText(event)
      const keys = event.action === 'complete' ? '' : event.action === 'classify' ? event.key : `${event.bank} ↔ ${event.books}`
      const lapsed = report.lapsed.find((l) => l.decision === event.seq)
      return [String(event.seq), event.at, what, keys, detail, lapsed ? lapsed.reason : '']
    }),
  }
  return [summary, matches, outstanding, members, problems, decisions]
}
