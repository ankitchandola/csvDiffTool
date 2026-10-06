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

function readWorkbook(bytes: ArrayBuffer, sheet: string | undefined): XLSX.WorkBook | null {
  try {
    // cellStyles is what makes SheetJS read hidden rows and columns.
    return XLSX.read(bytes, { type: 'array', dense: true, cellStyles: true, sheets: sheet ?? 0 })
  } catch {
    return null
  }
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

  const workbook = readWorkbook(bytes, sheet)
  if (!workbook) return fail('file', NOT_XLSX_MESSAGE)
  const sheets = workbook.SheetNames
  const name = sheet ?? sheets[0]
  const worksheet = name === undefined ? undefined : workbook.Sheets[name]
  if (!worksheet) return fail('file', sheet ? `This workbook has no sheet named "${sheet}".` : 'The workbook has no sheets.')

  const grid = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, raw: false, defval: '', blankrows: false })
  const cells = grid.map((row) => row.map((value) => String(value ?? '')))
  if (cells.length === 0) return fail('header', `Sheet "${name}" is empty`)

  const width = namedWidth(cells[0].map((h) => h.trim()))
  const headers = cells[0].slice(0, width).map((h) => h.trim())
  if (width === 0) return fail('header', `Sheet "${name}" has no header row`)
  const problems = headerIssues(headers)
  if (problems.length > 0) return { ok: false, issues: problems }
  if ((cells.length - 1) * width > limits.maxFields) return fail('file', tooManyFieldsMessage(limits.maxFields))

  const rows: Row[] = []
  const issues: ParseIssue[] = []
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
