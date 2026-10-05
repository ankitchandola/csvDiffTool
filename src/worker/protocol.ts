import type { ParseIssue } from '../engine/parse'
import type {
  AmbiguousKey,
  CompareProfile,
  CompareSummary,
  Delimiter,
  EmptyKeyRecord,
  KeyRules,
  ParseRules,
  Row,
  Side,
} from '../engine/types'

export const PREVIEW_RECORDS = 20
export const MAX_REPORTED_KEYS = 50

export interface FileInfo {
  headers: string[]
  recordCount: number
  delimiter: Delimiter
  preview: Row[]
}

export type ParseResult =
  | { ok: true; info: FileInfo }
  | { ok: false; issues: ParseIssue[]; issueCount: number }

export interface KeyProblems {
  ambiguous: AmbiguousKey[]
  emptyKey: EmptyKeyRecord[]
}

export interface KeyReport extends KeyProblems {
  counts: { matched: number; added: number; removed: number; ambiguous: number; emptyKey: number }
}

export interface CompareResult extends KeyProblems {
  summary: CompareSummary
}

export interface Requests {
  parse: { side: Side; file: File; rules: ParseRules }
  checkKeys: { rules: KeyRules }
  compare: { profile: CompareProfile }
}

export interface Results {
  parse: ParseResult
  checkKeys: KeyReport
  compare: CompareResult
}

export type RequestType = keyof Requests

export type WorkerRequest = {
  [K in RequestType]: { id: number; type: K } & Requests[K]
}[RequestType]

export type WorkerResponse =
  | { id: number; ok: true; result: Results[RequestType] }
  | { id: number; ok: false; message: string }
