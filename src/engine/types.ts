export type Delimiter = ',' | ';' | '\t'

export type Side = 'old' | 'new'

export interface ParseRules {
  delimiter: 'auto' | Delimiter
  trimHeaders: true
}

export interface KeyRules {
  columns: string[]
  trim: boolean
  caseInsensitive: boolean
}

export interface NumericRule {
  tolerance: string
  stripThousandsSeparator: boolean
}

export interface ValueRules {
  ignoredColumns: string[]
  trim: boolean
  caseInsensitive: string[]
  numeric: Record<string, NumericRule>
}

export interface CompareProfile {
  name: string
  parse: ParseRules
  key: KeyRules
  value: ValueRules
}

// Valid because records with the wrong field count are rejected at parse time.
export type Row = Record<string, string>

// rows[i] is record number i + 1; the header record is not counted.
export interface ParsedFile {
  headers: string[]
  rows: Row[]
  delimiter: Delimiter
}

export interface KeyRef {
  encoded: string
  parts: string[]
}

export interface KeyedRecord {
  recordNumber: number
  parts: string[]
}

export interface AmbiguousKey {
  encoded: string
  old: KeyedRecord[]
  new: KeyedRecord[]
}

export interface EmptyKeyRecord extends KeyedRecord {
  side: Side
}

export interface FieldChange {
  column: string
  before: string
  after: string
}

export interface CompareWarning {
  column: string
  side: Side
  recordNumber: number
  message: string
}

export interface SchemaDiff {
  added: string[]
  removed: string[]
  shared: string[]
}

export interface CompareSummary {
  schema: SchemaDiff
  counts: {
    added: number
    removed: number
    changed: number
    unchanged: number
    ambiguous: number
    emptyKey: number
  }
  changesByColumn: Record<string, number>
  warnings: CompareWarning[]
  warningCount: number
  rulesUsed: CompareProfile
}
