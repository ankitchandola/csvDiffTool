import * as XLSX from 'xlsx'
import { emptyDict } from './dict'
import type { Limits } from './limits'
import { tooManyFieldsMessage, unpackedTooLargeMessage } from './limits'
import { headerIssues, type ParseIssue, type ParseOutcome } from './parse'
import type { ProgressFn, Row } from './types'
import { savedResults } from './xlsx-xml'
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
    // cellStyles is what makes SheetJS read hidden rows and columns. sheetStubs keeps cells
    // that have no value: without it, a formula with no saved result is dropped entirely.
    const options = { type: 'array', dense: true, cellStyles: true, sheetStubs: true, sheets: name, sheetRows } as const
    return XLSX.read(bytes, options).Sheets[name] ?? null
  } catch {
    return null
  }
}

interface Grid {
  // Non-blank sheet rows as displayed text; rows[0] is the header.
  rows: string[][]
  // Formula cells saved without a result, as [index into rows, column index, formula].
  uncached: [number, number, string][]
  // Formula cells saved with an empty, untyped result, read as "" (see SavedResult).
  untypedEmpty: number
}

// Walks the used range cell by cell. format_cell gives the displayed text, the same
// text sheet_to_json produces; walking ourselves also finds formulas with no saved
// result. A saved 0 or FALSE has a value. Every formula cell that reads as empty (a stub
// 'z', where SheetJS may still set v to 0; an empty string; no value) is settled from the
// XML, because a missing result and a saved "" can read the same.
function readGrid(sheet: XLSX.WorkSheet, bytes: ArrayBuffer, sheetName: string): Grid {
  const rows: string[][] = []
  const uncached: Grid['uncached'] = []
  const stubs: { index: number; column: number; formula: string; ref: string }[] = []
  if (!sheet['!ref']) return { rows, uncached, untypedEmpty: 0 }
  const range = XLSX.utils.decode_range(sheet['!ref'])
  const data = sheet['!data'] ?? []
  for (let r = range.s.r; r <= range.e.r; r++) {
    const values: string[] = []
    let formulas = false
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = data[r]?.[c]
      const column = c - range.s.c
      if (cell?.f !== undefined && (cell.t === 'z' || cell.v === undefined || cell.v === '')) {
        stubs.push({ index: rows.length, column, formula: cell.f, ref: XLSX.utils.encode_cell({ r, c }) })
        formulas = true
        values.push('')
        continue
      }
      values.push(cell ? XLSX.utils.format_cell(cell) : '')
    }
    if (!formulas && values.every((value) => value === '')) continue
    rows.push(values)
  }
  let untypedEmpty = 0
  if (stubs.length > 0) {
    const results = savedResults(bytes, sheetName, stubs.map((stub) => stub.ref))
    for (const stub of stubs) {
      const result = results?.get(stub.ref)
      if (result === 'untyped-empty') untypedEmpty++
      if (result === undefined || result === 'none') uncached.push([stub.index, stub.column, stub.formula])
    }
  }
  return { rows, uncached, untypedEmpty }
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
  let grid = readGrid(worksheet, bytes, name)
  if (grid.rows.length === 0) return failIn('header', `Sheet "${name}" is empty`)
  if (truncated) {
    // The declared width can include empty columns past the last header; recheck at the real width.
    const width = namedWidth(grid.rows[0].map((h) => h.trim()))
    if ((outline.rows - 1) * width > limits.maxXlsxFields) return failIn('file', tooManyFieldsMessage(limits.maxXlsxFields))
    worksheet = readWorksheet(bytes, name)
    if (!worksheet) return failIn('file', NOT_XLSX_MESSAGE)
    grid = readGrid(worksheet, bytes, name)
  }
  const { rows: cells, uncached, untypedEmpty } = grid

  const uncachedMessage = (where: string, formula: string) =>
    `${where} has a formula (=${formula}) with no saved result. Open the workbook in Excel and save it so results are stored.`
  // Checked before header names: an unsaved header formula otherwise shows as an empty header.
  const headerFormulas = uncached.filter(([index]) => index === 0)
  if (headerFormulas.length > 0) {
    return { ok: false, issues: headerFormulas.map(([, column, formula]) => ({ kind: 'header', message: uncachedMessage(`Header column ${column + 1}`, formula) })), format }
  }
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
    const message = uncachedMessage(`Column "${headers[column] ?? column + 1}"`, formula)
    issues.push({ kind: 'record', recordNumber: index, message, raw: cells[index].join(', ') })
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
  const notes = sheetNotes(worksheet)
  if (untypedEmpty > 0) {
    notes.push(
      `${untypedEmpty} formula cell${untypedEmpty === 1 ? '' : 's'} saved an empty result with no type and ${untypedEmpty === 1 ? 'is' : 'are'} read as empty. Excel types its results; if a script wrote this workbook without calculating it, open and save it in Excel first.`,
    )
  }
  return { ok: true, file: { headers, rows, format, notes } }
}
