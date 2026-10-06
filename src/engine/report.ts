import Papa from 'papaparse'
import { isPlainDecimal } from './decimal'
import type { DiffResult } from './diff'
import { keyParts } from './keys'
import { type ParsedFile, PROGRESS_EVERY, type ProgressFn } from './types'

export interface ReportInput {
  diff: DiffResult
  oldFile: ParsedFile
  newFile: ParsedFile
  oldName: string
  newName: string
  generatedAt: string
}

export const REPORT_FORMAT = 'csv-diff-report'
export const REPORT_VERSION = 1
export const CHANGES_CSV_HEADER = ['change_type', 'key', 'column', 'before', 'after']

const CHUNK_CHARS = 1 << 20

// Collects output into ~1M-character chunks for a Blob, so no single string has to
// hold the whole export.
function chunkWriter() {
  const chunks: string[] = []
  let parts: string[] = []
  let size = 0
  return {
    write(text: string) {
      parts.push(text)
      size += text.length
      if (size >= CHUNK_CHARS) {
        chunks.push(parts.join(''))
        parts = []
        size = 0
      }
    },
    finish(): string[] {
      if (parts.length > 0) chunks.push(parts.join(''))
      return chunks
    },
  }
}

// A value starting with one of these can run as a formula when the CSV is opened in a spreadsheet.
const FORMULA_STARTS = new Set(['=', '+', '-', '@', '\t', '\r'])

// Plain signed numbers such as -12 can't run, so they stay unescaped and remain numbers in Excel.
export function escapeFormula(value: string): string {
  return FORMULA_STARTS.has(value.charAt(0)) && !isPlainDecimal(value) ? `'${value}` : value
}

const ROWS_PER_BATCH = 1000

function csvRows(write: (text: string) => void, escapeFormulae: boolean) {
  const config = { newline: '\r\n' }
  const cell = escapeFormulae ? escapeFormula : (value: string) => value
  let batch: string[][] = []
  const flush = () => {
    if (batch.length === 0) return
    write(Papa.unparse(batch, config) + '\r\n')
    batch = []
  }
  return {
    row(fields: string[]) {
      batch.push(fields.map(cell))
      if (batch.length >= ROWS_PER_BATCH) flush()
    },
    flush,
  }
}

// A single-column key is written as its value; a composite key as a JSON array of its parts.
export function keyCell(parts: string[]): string {
  return parts.length === 1 ? parts[0] : JSON.stringify(parts)
}

function progress(onProgress: ProgressFn | undefined, total: number) {
  let done = 0
  return () => {
    done++
    if (onProgress && done % PROGRESS_EVERY === 0) onProgress('export', done, total)
  }
}

// Long format: one line per field. Added and removed records list every column of their
// file, with the value under after or before; changed records list only the changed fields.
// Starts with a BOM so Excel reads the file as UTF-8. Only this CSV escapes formulas; the
// engine and the JSON report keep values exactly as read.
export function buildChangesCsv(
  input: ReportInput,
  { escapeFormulae = true }: { escapeFormulae?: boolean } = {},
  onProgress?: ProgressFn,
): string[] {
  const { diff, oldFile, newFile } = input
  const rules = diff.summary.rulesUsed.key
  const out = chunkWriter()
  const csv = csvRows(out.write, escapeFormulae)
  const total = diff.keys.added.length + diff.keys.removed.length + diff.changed.length
  const tick = progress(onProgress, total)

  out.write('\uFEFF')
  csv.row(CHANGES_CSV_HEADER)
  for (const index of diff.keys.added) {
    const row = newFile.rows[index]
    const key = keyCell(keyParts(row, rules))
    for (const column of newFile.headers) csv.row(['added', key, column, '', row[column]])
    tick()
  }
  for (const index of diff.keys.removed) {
    const row = oldFile.rows[index]
    const key = keyCell(keyParts(row, rules))
    for (const column of oldFile.headers) csv.row(['removed', key, column, row[column], ''])
    tick()
  }
  for (const record of diff.changed) {
    const key = keyCell(record.key.parts)
    for (const change of record.changes) csv.row(['changed', key, change.column, change.before, change.after])
    tick()
  }
  csv.flush()
  onProgress?.('export', total, total)
  return out.finish()
}

// The rules come first so whoever opens the report sees how it was produced.
export function buildJsonReport(input: ReportInput, onProgress?: ProgressFn): string[] {
  const { diff, oldFile, newFile } = input
  const { rulesUsed, ...summary } = diff.summary
  const rules = rulesUsed.key
  const out = chunkWriter()
  const total = diff.keys.added.length + diff.keys.removed.length + diff.changed.length
  const tick = progress(onProgress, total)

  function list<T>(name: string, items: T[], toJson: (item: T) => unknown, last = false) {
    out.write(`  ${JSON.stringify(name)}: [`)
    items.forEach((item, i) => out.write((i === 0 ? '\n    ' : ',\n    ') + JSON.stringify(toJson(item))))
    out.write(items.length > 0 ? '\n  ]' : ']')
    out.write(last ? '\n' : ',\n')
  }

  out.write('{\n')
  out.write(`  "format": ${JSON.stringify(REPORT_FORMAT)},\n  "version": ${REPORT_VERSION},\n`)
  out.write(`  "rulesUsed": ${JSON.stringify(rulesUsed)},\n`)
  out.write(`  "files": ${JSON.stringify({ old: input.oldName, new: input.newName })},\n`)
  out.write(`  "generatedAt": ${JSON.stringify(input.generatedAt)},\n`)
  out.write(`  "summary": ${JSON.stringify(summary)},\n`)
  list('added', diff.keys.added, (index) => {
    tick()
    const row = newFile.rows[index]
    return { key: keyParts(row, rules), recordNumber: index + 1, record: row }
  })
  list('removed', diff.keys.removed, (index) => {
    tick()
    const row = oldFile.rows[index]
    return { key: keyParts(row, rules), recordNumber: index + 1, record: row }
  })
  list('changed', diff.changed, (c) => {
    tick()
    return {
      key: c.key.parts,
      oldKey: keyParts(oldFile.rows[c.oldIndex], rules),
      oldRecordNumber: c.oldIndex + 1,
      newRecordNumber: c.newIndex + 1,
      changes: c.changes,
    }
  })
  list('ambiguous', diff.keys.ambiguous, (group) => ({ old: group.old, new: group.new }))
  list('emptyKey', diff.keys.emptyKey, (record) => record)
  list('warnings', diff.warnings, (warning) => warning, true)
  out.write('}\n')
  onProgress?.('export', total, total)
  return out.finish()
}
