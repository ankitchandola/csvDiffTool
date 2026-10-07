import type { Layout, ParseIssue } from '../engine/parse'
import type { Delimiter, FileFormat, Span } from '../engine/types'
import type { Tier } from '../reconciliation/match'
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

export type NormalizeResult =
  | { ok: false; issues: { side: ReconSide | null; message: string }[] }
  | { ok: true; revision: number; sides: Record<ReconSide, SideSummary> }

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
}

export interface ProblemItem extends Location {
  kind: 'invalid' | 'zero'
  fields: ProblemField[]
  messages: string[]
  original: OriginalValues
}

export interface ReviewItems {
  suggested: SuggestionItem
  unmatched: TransactionView
  problems: ProblemItem
}

export type ReviewTab = keyof ReviewItems

export type ReviewPage = {
  [K in ReviewTab]: { tab: K; total: number; offset: number; items: ReviewItems[K][] }
}[ReviewTab]

export interface ReconRequests {
  parse: { side: ReconSide; file: File; delimiter: 'auto' | Delimiter; sheet?: string; layout: Layout }
  getIssues: { side: ReconSide; offset: number; limit: number }
  normalize: { context: SessionContext; mappings: Record<ReconSide, SideMapping> }
  match: { revision: number; rules: MatchingRules }
  // search keeps items whose shown text contains it, case-insensitively; direction keeps one cash direction.
  getReview: { matchId: number; tab: ReviewTab; offset: number; limit: number; search?: string; direction?: Direction }
}

export interface ReconResults {
  parse: SourceResult
  getIssues: Omit<IssuesPage, 'side'> & { side: ReconSide }
  normalize: NormalizeResult
  match: MatchSummary
  getReview: ReviewPage
}

export type ReconRequest = {
  [K in keyof ReconRequests]: { id: number; type: K } & ReconRequests[K]
}[keyof ReconRequests]
