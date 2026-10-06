import * as XLSX from 'xlsx'
import type { ReportInput } from './report'
import { PROGRESS_EVERY, type ProgressFn, type Side } from './types'

// Excel's own limits: a sheet holds 1,048,576 rows (one is the header) and 16,384
// columns, and a cell 32,767 characters.
export const MAX_SHEET_ROWS = 1_048_575
export const MAX_SHEET_COLUMNS = 16_384
export const MAX_CELL_CHARS = 32_767

export interface XlsxExportLimits {
  maxSheetRows: number
  maxSheetColumns: number
  maxCellChars: number
  // Memory caps: the workbook is built whole, and its cost grows with both the number
  // of cells and the amount of text in them.
  maxCells: number
  maxTextChars: number
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
  // Names a row in refusal messages: "record 12", "item Rules used".
  describeRow: (row: string[], index: number) => string
}

const n = (value: number) => value.toLocaleString('en-US')

function refuse(message: string): never {
  throw new ExportRefused(`${message} ${ALTERNATIVE}`)
}

// Checks every Excel and memory limit from the tables alone, before any SheetJS object
// is built, so a refusal costs no workbook memory.
function validate(tables: Table[], limits: XlsxExportLimits) {
  let cells = 0
  let text = 0
  for (const table of tables) {
    if (table.rows.length > limits.maxSheetRows) {
      refuse(`The ${table.name} sheet would have ${n(table.rows.length)} rows; an .xlsx sheet holds ${n(limits.maxSheetRows)}.`)
    }
    if (table.header.length > limits.maxSheetColumns) {
      refuse(`The ${table.name} sheet would have ${n(table.header.length)} columns; an .xlsx sheet holds ${n(limits.maxSheetColumns)}.`)
    }
    const all = [table.header, ...table.rows]
    for (let r = 0; r < all.length; r++) {
      for (let c = 0; c < all[r].length; c++) {
        const value = all[r][c]
        cells++
        text += value.length
        if (value.length > limits.maxCellChars) {
          const address = XLSX.utils.encode_cell({ r, c })
          const where = r === 0 ? `the header of column ${c + 1}` : `column "${table.header[c]}", ${table.describeRow(all[r], r - 1)}`
          refuse(`Cell ${table.name}!${address} (${where}) has ${n(value.length)} characters; an .xlsx cell holds ${n(limits.maxCellChars)}.`)
        }
      }
    }
  }
  if (cells > limits.maxCells) {
    refuse(`This result needs ${n(cells)} cells; the .xlsx export is limited to ${n(limits.maxCells)} cells so it fits in browser memory.`)
  }
  if (text > limits.maxTextChars) {
    refuse(`This result holds ${n(text)} characters of text; the .xlsx export is limited to ${n(limits.maxTextChars)} so it fits in browser memory.`)
  }
}

// Widths from the header and a sample of rows: enough to read, without scanning every row.
function widths(table: Table): { wch: number }[] {
  return table.header.map((title, c) => {
    let width = title.length
    for (const row of table.rows.slice(0, WIDTH_SAMPLE_ROWS)) width = Math.max(width, row[c]?.length ?? 0)
    return { wch: Math.min(MAX_WIDTH, width + 2) }
  })
}

// Excel's format reads _xHHHH_ in text as an escaped character, so a literal "_x0041_"
// would open as "A". Escaping its underscore (_x005F_) keeps it literal. SheetJS escapes
// carriage returns and control characters itself, but not this.
function escapeLiteral(text: string): string {
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, '_x005F_x$1_')
}

// The text-safety invariant: every cell is built here, fresh, as { t: 's', v: text }.
// Nothing from an input workbook is copied, so no cell can carry a formula (f), a number
// type or a format, and record numbers and counts are text like everything else.
function sheet(table: Table): XLSX.WorkSheet {
  const data = [table.header, ...table.rows].map((row) => row.map((text): XLSX.CellObject => ({ t: 's', v: escapeLiteral(text) })))
  const ref = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: table.rows.length, c: table.header.length - 1 } })
  return { '!data': data, '!ref': ref, '!cols': widths(table), '!autofilter': { ref } }
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
  const sheetRows = (label: string, file: typeof oldFile) =>
    file.format.kind === 'xlsx' ? [[`${label} sheet`, file.format.sheet]] : []
  const byItem = (row: string[]) => `item "${row[0]}"`
  const byRecord = (row: string[]) => `record ${row[0]}`
  const summary: Table = {
    name: 'Summary',
    header: ['Item', 'Value'],
    describeRow: byItem,
    rows: [
      ['Old file', input.oldName],
      ...sheetRows('Old', oldFile),
      ['New file', input.newName],
      ...sheetRows('New', newFile),
      ['Generated at', input.generatedAt],
      ...Object.entries(counts).map(([name, value]) => [`Count: ${name}`, String(value)]),
      ...Object.entries(changesByColumn).map(([column, value]) => [`Changes in: ${column}`, String(value)]),
      ['Rules used', JSON.stringify(diff.summary.rulesUsed)],
      ['Note', 'Every cell is text: convert a column to numbers in your spreadsheet before calculating with it.'],
      [
        'Note',
        "Values are each file's original text, even where the comparison rules trimmed them, ignored case or compared them as numbers.",
      ],
      ['Note', 'Record numbers count data records only: the header and skipped blank lines are not counted.'],
      ['Note', 'Unchanged records are not included.'],
    ],
  }
  const records = (name: string, indices: number[], headers: string[], rows: typeof oldFile.rows): Table => ({
    name,
    header: ['Record', ...headers],
    describeRow: byRecord,
    rows: indices.map((index) => {
      tick()
      const row = rows[index]
      return [String(index + 1), ...headers.map((h) => row[h])]
    }),
  })
  const added = records('Added', diff.keys.added, newFile.headers, newFile.rows)
  const removed = records('Removed', diff.keys.removed, oldFile.headers, oldFile.rows)
  const keyCount = keyHeader.length
  const changed: Table = {
    name: 'Changed',
    header: [...keyHeader, 'Old record', 'New record', 'Column', 'Before', 'After'],
    describeRow: (row) => `old record ${row[keyCount]}, new record ${row[keyCount + 1]}`,
    rows: diff.changed.flatMap((record) => {
      tick()
      const prefix = [...record.key.parts, String(record.oldIndex + 1), String(record.newIndex + 1)]
      return record.changes.map((change) => [...prefix, change.column, change.before, change.after])
    }),
  }
  const byFileRecord = (row: string[]) => `${row[keyCount]} record ${row[keyCount + 1]}`
  const ambiguous: Table = {
    name: 'Ambiguous keys',
    header: [...keyHeader, 'File', 'Record'],
    describeRow: byFileRecord,
    rows: diff.keys.ambiguous.flatMap((group) =>
      (['old', 'new'] as const).flatMap((side) =>
        group[side].map((member) => [...member.parts, SIDE_NAMES[side], String(member.recordNumber)]),
      ),
    ),
  }
  const emptyKeys: Table = {
    name: 'Empty keys',
    header: [...keyHeader, 'File', 'Record'],
    describeRow: byFileRecord,
    rows: diff.keys.emptyKey.map((record) => [...record.parts, SIDE_NAMES[record.side], String(record.recordNumber)]),
  }
  const warnings: Table = {
    name: 'Numeric warnings',
    header: ['Column', 'File', 'Record', 'Message'],
    describeRow: (row) => `${row[1]} record ${row[2]}`,
    rows: diff.warnings.map((w) => [w.column, SIDE_NAMES[w.side], String(w.recordNumber), w.message]),
  }

  const tables = [summary, added, removed, changed, ambiguous, emptyKeys, warnings]
  validate(tables, limits)

  const book = XLSX.utils.book_new()
  for (const table of tables) XLSX.utils.book_append_sheet(book, sheet(table), table.name)
  // bookSST stores text as shared strings, Excel's standard form; the default t="str" is
  // the type of a formula's string result. ignoreEC: false keeps Excel's "number stored
  // as text" indicators: suppressing them can crash Excel in Text to Columns, which is
  // how users are told to convert these text cells.
  const bytes = XLSX.write(book, { type: 'array', bookType: 'xlsx', bookSST: true, ignoreEC: false, compression: true }) as ArrayBuffer
  onProgress?.('export', total, total)
  return bytes
}
