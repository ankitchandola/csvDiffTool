import type { Layout, ParseIssue } from '../engine/parse'
import type { Delimiter, FileFormat, Span } from '../engine/types'
import type { Decimal } from '../engine/decimal'
import type { Bridge, RunningBalanceCheck, SideBalances } from '../reconciliation/accounting'
import type { Classification, DecisionEvent, NewDecision, Pair, PairCheck, PairEvent, TxnKey } from '../reconciliation/decisions'
import type { ReviewFacts, Statuses } from '../reconciliation/statuses'
import type { Period } from '../reconciliation/carryforward'
import type { Tier } from '../reconciliation/match'
import type { AccountingSetup, TransactionSnapshot } from '../reconciliation/session'
import type { Direction, MatchingRules, ProblemField, ReconSide, SessionContext, SideMapping } from '../reconciliation/types'
import type { FileInfo, IssuesPage, Preview } from './protocol'

export const PREVIEW_SKIPPED = 20
export const SAMPLE_ROWS = 10

export type ReconPhase = 'parse' | 'normalize' | 'match'

export interface ReconProgress {
  phase: ReconPhase
  done: number
  total: number
}

export interface SourceInfo extends FileInfo {
  // SHA-256 of the file's bytes, hex.
  fingerprint: string
  // Records outside the table that the layout skipped, as raw text.
  skipped: { before: Preview<string>; after: Preview<string> }
}

export type SourceResult =
  | { ok: true; info: SourceInfo }
  | { ok: false; issues: Preview<ParseIssue>; format?: FileFormat }

// The mapped cells as written in the file.
export interface OriginalValues {
  date: string
  // One cell for a signed amount; "in / out" cells for separate columns.
  amount: string[]
  reference: string | null
  description: string | null
}

export interface Location {
  side: ReconSide
  recordNumber: number
  // Physical lines for a CSV, worksheet rows for an .xlsx.
  span: Span | null
  // Set for an opening item: recordNumber is then its record in the file it first
  // appeared in, an earlier period's file.
  carried?: { lineage: string; fileName: string; period: Period }
}

export interface SampleRow extends Location {
  original: OriginalValues
  // Null when the row has a problem or a zero amount.
  normalized: { date: string; amount: string; direction: Direction } | null
  zero: boolean
  problems: string[]
}

export interface SideSummary {
  rows: number
  valid: number
  moneyIn: number
  moneyOut: number
  zero: number
  // Rows with at least one problem; problems counts every problem.
  problemRows: number
  problems: number
  sample: SampleRow[]
}

export interface OpeningOverlap {
  lineage: string
  side: ReconSide
  // Current records with the same date, amount and reference as the carried item.
  records: number[]
}

export type NormalizeResult =
  | { ok: false; issues: { side: ReconSide | null; message: string }[] }
  | {
      ok: true
      revision: number
      sides: Record<ReconSide, SideSummary>
      opening: { items: Record<ReconSide, number>; warnings: string[]; overlaps: OpeningOverlap[] }
    }

export interface OpeningFileInfo {
  name: string
  fingerprint: string
  period: Period
  account: string
  items: number
  cleared: number
}

export type SetOpeningResult = { ok: true; files: OpeningFileInfo[] } | { ok: false; errors: { name: string; message: string }[] }

export interface MatchSummary {
  matchId: number
  revision: number
  rules: MatchingRules
  // Units: candidate pairs.
  pairs: number
  // Units: conflict groups.
  groups: number
  uniqueGroups: number
  // Units: transactions.
  withCandidates: Record<ReconSide, number>
  noCandidate: Record<ReconSide, number>
  invalid: Record<ReconSide, number>
  zero: Record<ReconSide, number>
  // Units: pairs that met amount and date rules but whose references differ.
  referenceConflicts: number
  incomplete: string | null
}

export interface TransactionView extends Location {
  key: TxnKey
  date: string
  amount: string
  direction: Direction
  reference: string | null
  original: OriginalValues
}

export interface SuggestionItem {
  group: number
  // Size of the group this pair belongs to, so competition is visible on every row.
  groupBank: number
  groupBooks: number
  groupPairs: number
  unique: boolean
  tier: Tier
  // Bank date minus books date, in days.
  gap: number
  bank: TransactionView
  books: TransactionView
  // Set when the pair's group is a repeated, identical transaction on each side.
  set: SetKind | null
}

// 'interchangeable': on each side every member has the same date, amount, direction,
// reference and description, so any pairing is economically the same.
// 'different-descriptions': the same except for descriptions; reviewed pair by pair.
export type SetKind = 'interchangeable' | 'different-descriptions'

// Members still available for bulk confirmation, in source order.
export interface SetView {
  group: number
  kind: SetKind
  bank: TransactionView[]
  books: TransactionView[]
  // Why the set can't be confirmed in one action now, if it can't.
  blocked: string | null
}

export interface InspectDetail {
  view: TransactionView
  // The whole source row, in the file's column order.
  headers: string[]
  values: string[]
  match: { other: TransactionView; event: PairEvent } | null
  // Open suggestions this transaction is in, first few of total.
  alternatives: SuggestionItem[]
  alternativesTotal: number
  rejectedPairs: number
}

export interface ProblemItem extends Location {
  kind: 'invalid' | 'zero'
  fields: ProblemField[]
  messages: string[]
  original: OriginalValues
}

export interface ConfirmedItem {
  bank: TransactionView
  books: TransactionView
  event: PairEvent
  // Set when the pair is also a current suggestion.
  tier: Tier | null
  gap: number
}

export interface UnmatchedItem extends TransactionView {
  // Current suggestions this transaction still appears in.
  suggestions: number
  classification: { value: Classification; note: string | null } | null
}

export interface AccountingReport {
  bridge: Bridge
  statuses: Statuses
  // Balances in cash terms, as used; null where not entered or not valid.
  balances: Record<ReconSide, SideBalances>
  // Balance text that could not be read, per side and field.
  balanceErrors: string[]
  movement: Record<ReconSide, Decimal>
  facts: ReviewFacts
  // Null where no running-balance column is mapped or the opening balance is missing.
  running: Record<ReconSide, RunningBalanceCheck | null>
}

export type MarkCompleteResult =
  | { ok: true; event: DecisionEvent; report: AccountingReport }
  | { ok: false; reason: string }

// Views are null when the transaction is no longer valid in the current files.
export interface RejectedItem {
  bankKey: TxnKey
  booksKey: TxnKey
  bank: TransactionView | null
  books: TransactionView | null
  event: PairEvent
}

export interface ReviewItems {
  suggested: SuggestionItem
  confirmed: ConfirmedItem
  unmatched: UnmatchedItem
  rejected: RejectedItem
  problems: ProblemItem
}

export type ReviewTab = keyof ReviewItems

export type ReviewPage = {
  [K in ReviewTab]: { tab: K; total: number; offset: number; items: ReviewItems[K][] }
}[ReviewTab]

export interface LapsedView {
  event: DecisionEvent
  reason: string
}

// Units: candidate pairs for suggested, confirmed pairs, transactions for unmatched,
// rejected pairs, decisions for lapsed.
export interface DecisionSummary {
  suggested: number
  confirmed: number
  unmatched: Record<ReconSide, number>
  rejected: number
  lapsed: LapsedView[]
}

export type DecisionInput = NewDecision

export type DecideResult =
  | { ok: true; event: DecisionEvent; snapshots: TransactionSnapshot[]; summary: DecisionSummary }
  | { ok: false; reason: string }

export type DecideSetResult =
  | { ok: true; events: DecisionEvent[]; snapshots: TransactionSnapshot[]; summary: DecisionSummary }
  | { ok: false; reason: string }

export interface PairCheckResult extends PairCheck {
  bank: TransactionView | null
  books: TransactionView | null
}

export interface ReconRequests {
  parse: { side: ReconSide; file: File; delimiter: 'auto' | Delimiter; sheet?: string; layout: Layout }
  getIssues: { side: ReconSide; offset: number; limit: number }
  normalize: { context: SessionContext; mappings: Record<ReconSide, SideMapping>; period: Period | null }
  match: { revision: number; rules: MatchingRules }
  // search keeps items whose shown text contains it, case-insensitively; direction keeps one cash direction.
  getReview: { matchId: number; tab: ReviewTab; offset: number; limit: number; search?: string; direction?: Direction }
  // Replaces the worker's history with the session's, replayed against the current files and rules.
  setDecisions: { matchId: number; events: DecisionEvent[] }
  // seq must be the next in the history, so a decision can't be applied out of order.
  decide: { matchId: number; seq: number; at: string; decision: DecisionInput }
  checkPair: { matchId: number; bank: TxnKey; books: TxnKey }
  getSet: { matchId: number; group: number }
  // All pairs are validated before any is recorded: the set is confirmed whole or not at all.
  decideSet: { matchId: number; group: number; seq: number; at: string; pairs: Pair[] }
  // Null for a key that is not a valid transaction in the current files.
  inspect: { matchId: number; keys: TxnKey[] }
  // basis: the setup fingerprint a completion must match to stay current.
  accounting: { matchId: number; setup: AccountingSetup; basis: string }
  markComplete: { matchId: number; seq: number; at: string; setup: AccountingSetup; basis: string }
  // Replaces the imported opening-items files; each is validated whole.
  setOpening: { files: { name: string; text: string }[] }
  exportOutstanding: { matchId: number; sessionId: string; period: Period; exportedAt: string }
}

export interface ReconResults {
  parse: SourceResult
  getIssues: Omit<IssuesPage, 'side'> & { side: ReconSide }
  normalize: NormalizeResult
  match: MatchSummary
  getReview: ReviewPage
  setDecisions: DecisionSummary
  decide: DecideResult
  checkPair: PairCheckResult
  getSet: SetView
  decideSet: DecideSetResult
  inspect: (InspectDetail | null)[]
  accounting: AccountingReport
  markComplete: MarkCompleteResult
  setOpening: SetOpeningResult
  exportOutstanding: { text: string; items: number; cleared: number }
}

export type ReconRequest = {
  [K in keyof ReconRequests]: { id: number; type: K } & ReconRequests[K]
}[keyof ReconRequests]
