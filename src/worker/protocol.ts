import type { ParseIssue } from '../engine/parse'
import type {
  AmbiguousKey,
  CompareProfile,
  CompareSummary,
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
export const MAX_REPORTED_KEYS = 50
export const MAX_GROUP_MEMBERS = 10
export const MAX_PAGE_SIZE = 500

export interface FileInfo {
  headers: string[]
  recordCount: number
  delimiter: Delimiter
  preview: Row[]
}

export type ParseResult =
  | { ok: true; info: FileInfo }
  | { ok: false; issues: ParseIssue[]; issueCount: number }

// One duplicated key can cover thousands of records, so members are capped per group too.
export interface AmbiguousKeyPreview extends AmbiguousKey {
  oldCount: number
  newCount: number
}

export interface KeyProblems {
  ambiguous: AmbiguousKeyPreview[]
  emptyKey: EmptyKeyRecord[]
}

export interface KeyReport extends KeyProblems {
  counts: { matched: number; added: number; removed: number; ambiguous: number; emptyKey: number }
}

export interface CompareResult extends KeyProblems {
  summary: CompareSummary
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

export type RowsPage =
  | { tab: 'added' | 'removed'; total: number; offset: number; items: RecordEntry[] }
  | { tab: 'changed'; total: number; offset: number; items: ChangedEntry[] }

export interface Requests {
  parse: { side: Side; file: File; rules: ParseRules }
  checkKeys: { rules: KeyRules }
  compare: { profile: CompareProfile }
  getRows: { tab: RowsPage['tab']; offset: number; limit: number }
}

export interface Results {
  parse: ParseResult
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
