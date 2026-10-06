import * as XLSX from 'xlsx'
import { emptyDict } from './dict'
import type { Limits } from './limits'
import { tooManyFieldsMessage, unpackedTooLargeMessage } from './limits'
import { headerIssues, type ParseIssue, type ParseOutcome } from './parse'
import type { ProgressFn, Row } from './types'
import { unpackedSize } from './zip'

export const NOT_XLSX_MESSAGE =
  "This file couldn't be read as an .xlsx workbook. Open it in Excel and save it again as .xlsx or CSV UTF-8."

const fail = (kind: 'file' | 'header', message: string): ParseOutcome => ({ ok: false, issues: [{ kind, message }] })

function readSheetNames(bytes: ArrayBuffer): string[] | null {
  try {
    return XLSX.read(bytes, { type: 'array', bookSheets: true }).SheetNames
  } catch {
    return null
  }
}

function readWorksheet(bytes: ArrayBuffer, name: string): XLSX.WorkSheet | null {
  try {
    // cellStyles is what makes SheetJS read hidden rows and columns.
    return XLSX.read(bytes, { type: 'array', dense: true, cellStyles: true, sheets: name }).Sheets[name] ?? null
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

  const sheets = readSheetNames(bytes)
  if (!sheets) return fail('file', NOT_XLSX_MESSAGE)
  const name = sheet ?? sheets[0]
  if (name === undefined) return fail('file', 'The workbook has no sheets.')
  if (!sheets.includes(name)) return fail('file', `This workbook has no sheet named "${name}".`)
  const worksheet = readWorksheet(bytes, name)
  if (!worksheet) return fail('file', NOT_XLSX_MESSAGE)

  const { rows: cells, uncached } = readGrid(worksheet)
  if (cells.length === 0) return fail('header', `Sheet "${name}" is empty`)

  const width = namedWidth(cells[0].map((h) => h.trim()))
  const headers = cells[0].slice(0, width).map((h) => h.trim())
  if (width === 0) return fail('header', `Sheet "${name}" has no header row`)
  const problems = headerIssues(headers)
  if (problems.length > 0) return { ok: false, issues: problems }
  if ((cells.length - 1) * width > limits.maxXlsxFields) return fail('file', tooManyFieldsMessage(limits.maxXlsxFields))

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
  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, file: { headers, rows, format: { kind: 'xlsx', sheet: name, sheets }, notes: sheetNotes(worksheet) } }
}
