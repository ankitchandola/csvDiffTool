import * as XLSX from 'xlsx'
import type { ReportInput } from './report'
import { PROGRESS_EVERY, type ProgressFn, type Side } from './types'

// Excel's own limits: a sheet holds 1,048,576 rows (one is the header) and a cell 32,767 characters.
export const MAX_SHEET_ROWS = 1_048_575
export const MAX_CELL_CHARS = 32_767

export interface XlsxExportLimits {
  maxSheetRows: number
  maxCellChars: number
  maxCells: number
}

export class ExportRefused extends Error {}

const ALTERNATIVE = 'Download the changes CSV or the JSON report instead; they have no such limit.'
const SIDE_NAMES: Record<Side, string> = { old: 'old', new: 'new' }
const MAX_WIDTH = 50
const WIDTH_SAMPLE_ROWS = 1000

interface Table {
  name: string
  header: string[]
  rows: string[][]
}

// Widths from the header and a sample of rows: enough to read, without scanning every row.
function widths(table: Table): { wch: number }[] {
  return table.header.map((title, c) => {
    let width = title.length
    for (const row of table.rows.slice(0, WIDTH_SAMPLE_ROWS)) width = Math.max(width, row[c]?.length ?? 0)
    return { wch: Math.min(MAX_WIDTH, width + 2) }
  })
}

function check(table: Table, limits: XlsxExportLimits) {
  if (table.rows.length > limits.maxSheetRows) {
    throw new ExportRefused(
      `The ${table.name} sheet would have ${table.rows.length.toLocaleString('en-US')} rows; an .xlsx sheet holds ${limits.maxSheetRows.toLocaleString('en-US')}. ${ALTERNATIVE}`,
    )
  }
  table.rows.forEach((row, r) => {
    const c = row.findIndex((value) => value.length > limits.maxCellChars)
    if (c !== -1) {
      throw new ExportRefused(
        `A value in the ${table.name} sheet, column "${table.header[c]}", row ${r + 2}, has ${row[c].length.toLocaleString('en-US')} characters; an .xlsx cell holds ${limits.maxCellChars.toLocaleString('en-US')}. ${ALTERNATIVE}`,
      )
    }
  })
}

// Every value is a string, so aoa_to_sheet writes text cells: leading zeros, long IDs,
// dates and formula-like values stay exactly as compared, and nothing is evaluated.
function sheet(table: Table): XLSX.WorkSheet {
  const worksheet = XLSX.utils.aoa_to_sheet([table.header, ...table.rows], { dense: true })
  worksheet['!cols'] = widths(table)
  worksheet['!autofilter'] = {
    ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: table.rows.length, c: table.header.length - 1 } }),
  }
  return worksheet
}

export function buildXlsxReport(input: ReportInput, limits: XlsxExportLimits, onProgress?: ProgressFn): ArrayBuffer {
  const { diff, oldFile, newFile } = input
  const rules = diff.summary.rulesUsed.key
  const keyHeader = rules.columns.map((column) => `Key: ${column}`)
  const total = diff.keys.added.length + diff.keys.removed.length + diff.changed.length
  let done = 0
  const tick = () => {
    done++
    if (onProgress && done % PROGRESS_EVERY === 0) onProgress('export', done, total)
  }

  const { counts, changesByColumn } = diff.summary
  const summary: Table = {
    name: 'Summary',
    header: ['Item', 'Value'],
    rows: [
      ['Old file', input.oldName],
      ['New file', input.newName],
      ['Generated at', input.generatedAt],
      ...Object.entries(counts).map(([name, value]) => [`Count: ${name}`, String(value)]),
      ...Object.entries(changesByColumn).map(([column, value]) => [`Changes in: ${column}`, String(value)]),
      ['Rules used', JSON.stringify(diff.summary.rulesUsed)],
      ['Note', 'Every cell is text, exactly as compared: convert a column to numbers in your spreadsheet before calculating with it.'],
      ['Note', 'Record numbers count data records only: the header and skipped blank lines are not counted.'],
    ],
  }
  const records = (name: string, indices: number[], headers: string[], rows: typeof oldFile.rows): Table => ({
    name,
    header: ['Record', ...headers],
    rows: indices.map((index) => {
      tick()
      const row = rows[index]
      return [String(index + 1), ...headers.map((h) => row[h])]
    }),
  })
  const added = records('Added', diff.keys.added, newFile.headers, newFile.rows)
  const removed = records('Removed', diff.keys.removed, oldFile.headers, oldFile.rows)
  const changed: Table = {
    name: 'Changed',
    header: [...keyHeader, 'Old record', 'New record', 'Column', 'Before', 'After'],
    rows: diff.changed.flatMap((record) => {
      tick()
      const prefix = [...record.key.parts, String(record.oldIndex + 1), String(record.newIndex + 1)]
      return record.changes.map((change) => [...prefix, change.column, change.before, change.after])
    }),
  }
  const ambiguous: Table = {
    name: 'Ambiguous keys',
    header: [...keyHeader, 'File', 'Record'],
    rows: diff.keys.ambiguous.flatMap((group) =>
      (['old', 'new'] as const).flatMap((side) =>
        group[side].map((member) => [...member.parts, SIDE_NAMES[side], String(member.recordNumber)]),
      ),
    ),
  }
  const emptyKeys: Table = {
    name: 'Empty keys',
    header: [...keyHeader, 'File', 'Record'],
    rows: diff.keys.emptyKey.map((record) => [...record.parts, SIDE_NAMES[record.side], String(record.recordNumber)]),
  }
  const warnings: Table = {
    name: 'Numeric warnings',
    header: ['Column', 'File', 'Record', 'Message'],
    rows: diff.warnings.map((w) => [w.column, SIDE_NAMES[w.side], String(w.recordNumber), w.message]),
  }

  const tables = [summary, added, removed, changed, ambiguous, emptyKeys, warnings]
  const cells = tables.reduce((n, t) => n + (t.rows.length + 1) * t.header.length, 0)
  if (cells > limits.maxCells) {
    throw new ExportRefused(
      `This result needs ${cells.toLocaleString('en-US')} cells; the .xlsx export is limited to ${limits.maxCells.toLocaleString('en-US')} cells so it fits in browser memory. ${ALTERNATIVE}`,
    )
  }
  for (const table of tables) check(table, limits)

  const book = XLSX.utils.book_new()
  for (const table of tables) XLSX.utils.book_append_sheet(book, sheet(table), table.name)
  // bookSST stores text as shared strings, Excel's standard form; the default t="str" is
  // the type of a formula's string result.
  const bytes = XLSX.write(book, { type: 'array', bookType: 'xlsx', bookSST: true, compression: true }) as ArrayBuffer
  onProgress?.('export', total, total)
  return bytes
}
