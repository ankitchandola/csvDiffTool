import type { ParseIssue } from '../engine/parse'
import type {
  AmbiguousKey,
  CompareProfile,
  CompareSummary,
  CompareWarning,
  Delimiter,
  EmptyKeyRecord,
  FieldChange,
  KeyRef,
  KeyRules,
  ParseRules,
  Row,
  Side,
} from '../engine/types'

export const PREVIEW_RECORDS = 20
export const PREVIEW_ISSUES = 20
export const PREVIEW_PROBLEMS = 50
export const PREVIEW_WARNINGS = 100
export const MAX_GROUP_MEMBERS = 10
export const MAX_PAGE_SIZE = 500

// The worker keeps the complete list; the UI gets the first items and the total.
export interface Preview<T> {
  items: T[]
  total: number
}

export interface FileInfo {
  headers: string[]
  recordCount: number
  delimiter: Delimiter
  preview: Row[]
}

export type ParseResult = { ok: true; info: FileInfo } | { ok: false; issues: Preview<ParseIssue> }

// One duplicated key can cover thousands of records, so members are capped per group too.
export interface AmbiguousKeyPreview extends AmbiguousKey {
  oldCount: number
  newCount: number
}

export interface KeyProblems {
  ambiguous: Preview<AmbiguousKeyPreview>
  emptyKey: Preview<EmptyKeyRecord>
}

export interface KeyReport extends KeyProblems {
  counts: { matched: number; added: number; removed: number }
}

export interface CompareResult extends KeyProblems {
  summary: CompareSummary
  warnings: Preview<CompareWarning>
}

export interface RecordEntry {
  key: KeyRef
  recordNumber: number
  row: Row
}

export interface ChangedEntry {
  key: KeyRef
  oldRecordNumber: number
  newRecordNumber: number
  changes: FieldChange[]
}

export interface PageItems {
  added: RecordEntry
  removed: RecordEntry
  changed: ChangedEntry
  ambiguous: AmbiguousKeyPreview
  emptyKey: EmptyKeyRecord
  warnings: CompareWarning
}

export type ResultTab = keyof PageItems

export type RowsPage = {
  [K in ResultTab]: { tab: K; total: number; offset: number; items: PageItems[K][] }
}[ResultTab]

export interface IssuesPage {
  side: Side
  total: number
  offset: number
  items: ParseIssue[]
}

export interface Requests {
  parse: { side: Side; file: File; rules: ParseRules }
  getIssues: { side: Side; offset: number; limit: number }
  checkKeys: { rules: KeyRules }
  compare: { profile: CompareProfile }
  getRows: { tab: ResultTab; offset: number; limit: number }
}

export interface Results {
  parse: ParseResult
  getIssues: IssuesPage
  checkKeys: KeyReport
  compare: CompareResult
  getRows: RowsPage
}

export type RequestType = keyof Requests

export type WorkerRequest = {
  [K in RequestType]: { id: number; type: K } & Requests[K]
}[RequestType]

// id null: the worker could not read a request, so it can't say which one failed.
export type WorkerResponse =
  | { id: number; ok: true; result: Results[RequestType] }
  | { id: number | null; ok: false; message: string }
