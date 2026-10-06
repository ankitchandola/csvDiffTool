import * as XLSX from 'xlsx'
import { emptyDict } from './dict'
import type { Limits } from './limits'
import { tooManyFieldsMessage, unpackedTooLargeMessage } from './limits'
import { headerIssues, type ParseIssue, type ParseOutcome } from './parse'
import type { ProgressFn, Row } from './types'
import { unpackedSize } from './zip'

export const NOT_XLSX_MESSAGE =
  "This file couldn't be read as an .xlsx workbook. Open it in Excel and save it again as .xlsx or CSV UTF-8."

type Failure = Extract<ParseOutcome, { ok: false }>

const fail = (kind: 'file' | 'header', message: string): Failure => ({ ok: false, issues: [{ kind, message }] })

interface Outline {
  sheets: string[]
  // The sheet's declared used range: rows and columns as the file states them.
  rows: number
  columns: number
}

// A one-row read of the chosen sheet: enough for the sheet names and the declared size,
// without parsing the sheet's cells. sheets: 0 means the first sheet.
function readOutline(bytes: ArrayBuffer, sheet: string | number): Outline | null {
  try {
    const book = XLSX.read(bytes, { type: 'array', dense: true, sheets: sheet, sheetRows: 1 })
    const name = typeof sheet === 'number' ? book.SheetNames[sheet] : sheet
    const ref = name === undefined ? undefined : (book.Sheets[name]?.['!fullref'] ?? book.Sheets[name]?.['!ref'])
    if (!ref) return { sheets: book.SheetNames, rows: 0, columns: 0 }
    const range = XLSX.utils.decode_range(ref)
    return { sheets: book.SheetNames, rows: range.e.r - range.s.r + 1, columns: range.e.c - range.s.c + 1 }
  } catch {
    return null
  }
}

// sheetRows stops SheetJS parsing after that many worksheet rows, which is what bounds
// memory while parsing; a field count taken afterwards would not.
function readWorksheet(bytes: ArrayBuffer, name: string, sheetRows?: number): XLSX.WorkSheet | null {
  try {
    // cellStyles is what makes SheetJS read hidden rows and columns.
    return XLSX.read(bytes, { type: 'array', dense: true, cellStyles: true, sheets: name, sheetRows }).Sheets[name] ?? null
  } catch {
    return null
  }
}

interface Grid {
  // Non-blank sheet rows as displayed text; rows[0] is the header.
  rows: string[][]
  // Formula cells saved without a result, as [index into rows, column index, formula].
  uncached: [number, number, string][]
}

// Walks the used range cell by cell. format_cell gives the displayed text, the same
// text sheet_to_json produces; walking ourselves also finds formulas with no saved result.
function readGrid(sheet: XLSX.WorkSheet): Grid {
  const rows: string[][] = []
  const uncached: Grid['uncached'] = []
  if (!sheet['!ref']) return { rows, uncached }
  const range = XLSX.utils.decode_range(sheet['!ref'])
  const data = sheet['!data'] ?? []
  for (let r = range.s.r; r <= range.e.r; r++) {
    const values: string[] = []
    const missing: [number, string][] = []
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = data[r]?.[c]
      if (cell?.f !== undefined && cell.v === undefined) missing.push([c - range.s.c, cell.f])
      values.push(cell ? XLSX.utils.format_cell(cell) : '')
    }
    if (missing.length === 0 && values.every((value) => value === '')) continue
    for (const [column, formula] of missing) uncached.push([rows.length, column, formula])
    rows.push(values)
  }
  return { rows, uncached }
}

function hiddenCount(entries: { hidden?: boolean }[] | undefined): number {
  return (entries ?? []).filter((entry) => entry?.hidden).length
}

function sheetNotes(sheet: XLSX.WorkSheet): string[] {
  const notes: string[] = []
  const merges = sheet['!merges']?.length ?? 0
  const hiddenRows = hiddenCount(sheet['!rows'])
  const hiddenColumns = hiddenCount(sheet['!cols'])
  if (merges > 0) notes.push(`${merges} merged range${merges === 1 ? '' : 's'}: each value is read from its top-left cell only.`)
  if (hiddenRows > 0) notes.push(`${hiddenRows} hidden row${hiddenRows === 1 ? '' : 's'} included.`)
  if (hiddenColumns > 0) notes.push(`${hiddenColumns} hidden column${hiddenColumns === 1 ? '' : 's'} included.`)
  return notes
}

// Width is the last named header: empty columns past it carry no data and are ignored.
function namedWidth(header: string[]): number {
  let width = header.length
  while (width > 0 && header[width - 1] === '') width--
  return width
}

// Reads one sheet as displayed text (raw: false), so dates, percentages and currency
// compare as the user sees them and as a CSV export of the sheet would hold them.
export function parseXlsx(
  bytes: ArrayBuffer,
  sheet: string | undefined,
  limits: Limits,
  onProgress?: ProgressFn,
): ParseOutcome {
  const unpacked = unpackedSize(bytes)
  if (unpacked === null) return fail('file', NOT_XLSX_MESSAGE)
  if (unpacked > limits.maxUnpackedBytes) return fail('file', unpackedTooLargeMessage(limits.maxUnpackedBytes))

  const outline = readOutline(bytes, sheet ?? 0)
  if (!outline) return fail('file', NOT_XLSX_MESSAGE)
  const { sheets } = outline
  const name = sheet ?? sheets[0]
  if (name === undefined) return fail('file', 'The workbook has no sheets.')
  if (!sheets.includes(name)) return fail('file', `This workbook has no sheet named "${name}".`)
  const format = { kind: 'xlsx' as const, sheet: name, sheets }
  const failIn = (kind: 'file' | 'header', message: string): Failure => ({ ...fail(kind, message), format })
  if (outline.rows === 0) return failIn('header', `Sheet "${name}" is empty`)

  // Enough worksheet rows for the field limit at the declared width, plus the header.
  // Declared rows include blank ones, so the limit is checked over declared rows.
  const rowBudget = Math.floor(limits.maxXlsxFields / outline.columns) + 1
  const truncated = outline.rows > rowBudget
  let worksheet = readWorksheet(bytes, name, truncated ? rowBudget : undefined)
  if (!worksheet) return failIn('file', NOT_XLSX_MESSAGE)
  let grid = readGrid(worksheet)
  if (grid.rows.length === 0) return failIn('header', `Sheet "${name}" is empty`)
  if (truncated) {
    // The declared width can include empty columns past the last header; recheck at the real width.
    const width = namedWidth(grid.rows[0].map((h) => h.trim()))
    if ((outline.rows - 1) * width > limits.maxXlsxFields) return failIn('file', tooManyFieldsMessage(limits.maxXlsxFields))
    worksheet = readWorksheet(bytes, name)
    if (!worksheet) return failIn('file', NOT_XLSX_MESSAGE)
    grid = readGrid(worksheet)
  }
  const { rows: cells, uncached } = grid

  const width = namedWidth(cells[0].map((h) => h.trim()))
  const headers = cells[0].slice(0, width).map((h) => h.trim())
  if (width === 0) return failIn('header', `Sheet "${name}" has no header row`)
  const problems = headerIssues(headers)
  if (problems.length > 0) return { ok: false, issues: problems, format }
  if ((cells.length - 1) * width > limits.maxXlsxFields) return failIn('file', tooManyFieldsMessage(limits.maxXlsxFields))

  const rows: Row[] = []
  const issues: ParseIssue[] = []
  // Treating a formula with no saved result as empty would report a change that isn't there.
  for (const [index, column, formula] of uncached) {
    const where = index === 0 ? 'The header' : `Column "${headers[column] ?? column + 1}"`
    const message = `${where} has a formula (=${formula}) with no saved result. Open the workbook in Excel and save it so results are stored.`
    issues.push(index === 0 ? { kind: 'header', message } : { kind: 'record', recordNumber: index, message, raw: cells[index].join(', ') })
  }
  for (let i = 1; i < cells.length; i++) {
    const values = cells[i]
    if (values.slice(width).some((value) => value !== '')) {
      issues.push({ kind: 'record', recordNumber: i, message: `Has values beyond the ${width} named columns`, raw: values.join(', ') })
      continue
    }
    const row: Row = emptyDict()
    for (let c = 0; c < width; c++) row[headers[c]] = values[c] ?? ''
    rows.push(row)
  }
  onProgress?.('parse', 1, 1)
  if (issues.length > 0) return { ok: false, issues, format }
  return { ok: true, file: { headers, rows, format, notes: sheetNotes(worksheet) } }
}
