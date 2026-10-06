import * as XLSX from 'xlsx'
import { describe, expect, it } from 'vitest'
import { diffFiles } from './diff'
import { profile } from './fixtures.test-helper'
import { parseCsv } from './parse'
import type { ReportInput } from './report'
import type { CompareProfile } from './types'
import { buildXlsxReport, ExportRefused, MAX_CELL_CHARS, MAX_SHEET_ROWS, type XlsxExportLimits } from './xlsx-report'

const LIMITS: XlsxExportLimits = { maxSheetRows: MAX_SHEET_ROWS, maxCellChars: MAX_CELL_CHARS, maxCells: 1_000_000 }

function parsed(text: string) {
  const outcome = parseCsv(text, { delimiter: 'auto', trimHeaders: true })
  if (!outcome.ok) throw new Error('parse failed')
  return outcome.file
}

function input(oldText: string, newText: string, p: CompareProfile = profile({ columns: ['id'] })): ReportInput {
  const oldFile = parsed(oldText)
  const newFile = parsed(newText)
  return { diff: diffFiles(oldFile, newFile, p), oldFile, newFile, oldName: 'old.csv', newName: 'new.csv', generatedAt: '2026-10-06T00:00:00.000Z' }
}

function read(bytes: ArrayBuffer) {
  return XLSX.read(bytes, { type: 'array', cellFormula: true })
}

function rows(book: XLSX.WorkBook, name: string): string[][] {
  return XLSX.utils.sheet_to_json<string[]>(book.Sheets[name], { header: 1, raw: true, defval: '' })
}

const RISKY = 'id,code,since,total,big\n1,0007,2026-01-05,=SUM(A1),1234567890123456\n2,x,y,-12,z\n'
const RISKY_NEW = 'id,code,since,total,big\n1,0008,2026-01-06,=SUM(B1),1234567890123457\n2,x,y,-12,z\n3,0042,2026-02-01,=1+1,9\n'

describe('buildXlsxReport', () => {
  it('writes the sheets in order, all present even when empty', () => {
    const book = read(buildXlsxReport(input(RISKY, RISKY_NEW), LIMITS))
    expect(book.SheetNames).toEqual(['Summary', 'Added', 'Removed', 'Changed', 'Ambiguous keys', 'Empty keys', 'Numeric warnings'])
    expect(rows(book, 'Removed')).toEqual([['Record', 'id', 'code', 'since', 'total', 'big']])
  })

  it('writes every value as text, exactly as compared, and never as a formula', () => {
    const book = read(buildXlsxReport(input(RISKY, RISKY_NEW), LIMITS))
    expect(rows(book, 'Added')).toEqual([
      ['Record', 'id', 'code', 'since', 'total', 'big'],
      ['3', '3', '0042', '2026-02-01', '=1+1', '9'],
    ])
    expect(rows(book, 'Changed')).toEqual([
      ['Key: id', 'Old record', 'New record', 'Column', 'Before', 'After'],
      ['1', '1', '1', 'code', '0007', '0008'],
      ['1', '1', '1', 'since', '2026-01-05', '2026-01-06'],
      ['1', '1', '1', 'total', '=SUM(A1)', '=SUM(B1)'],
      ['1', '1', '1', 'big', '1234567890123456', '1234567890123457'],
    ])
    for (const name of book.SheetNames) {
      const data = book.Sheets[name]
      for (const ref of Object.keys(data).filter((k) => !k.startsWith('!'))) {
        expect(data[ref].t, `${name}!${ref}`).toBe('s')
        expect(data[ref].f, `${name}!${ref}`).toBeUndefined()
      }
    }
  })

  it('stores text as shared strings and sets an autofilter and widths', () => {
    const bytes = buildXlsxReport(input(RISKY, RISKY_NEW), LIMITS)
    const zip = XLSX.CFB.read(new Uint8Array(bytes), { type: 'array' })
    expect(zip.FullPaths.some((path: string) => path.endsWith('xl/sharedStrings.xml'))).toBe(true)
    const changed = read(bytes).Sheets.Changed
    expect(changed['!autofilter']).toEqual({ ref: 'A1:F5' })
  })

  it('gives each key column its own column, with key problems by file', () => {
    const p = profile({ columns: ['wh', 'sku'] })
    const oldText = 'wh,sku,qty\nA,1,5\nA,1,6\n,2,1\n'
    const newText = 'wh,sku,qty\nA,1,5\nB,3,1\n'
    const book = read(buildXlsxReport(input(oldText, newText, p), LIMITS))
    expect(rows(book, 'Ambiguous keys')).toEqual([
      ['Key: wh', 'Key: sku', 'File', 'Record'],
      ['A', '1', 'old', '1'],
      ['A', '1', 'old', '2'],
      ['A', '1', 'new', '1'],
    ])
    expect(rows(book, 'Empty keys')).toEqual([
      ['Key: wh', 'Key: sku', 'File', 'Record'],
      ['', '2', 'old', '3'],
    ])
  })

  it('lists numeric warnings and summarises the run', () => {
    const p = profile({ columns: ['id'] }, { numeric: { total: { tolerance: '0', stripThousandsSeparator: false } } })
    const report = input(RISKY, RISKY_NEW, p)
    const book = read(buildXlsxReport(report, LIMITS))
    expect(rows(book, 'Numeric warnings')[1]).toEqual(['total', 'old', '1', '"=SUM(A1)" is not a number; compared as text'])
    const summary = rows(book, 'Summary')
    expect(summary).toContainEqual(['Old file', 'old.csv'])
    expect(summary).toContainEqual(['Count: changed', '1'])
    expect(summary).toContainEqual(['Rules used', JSON.stringify(report.diff.summary.rulesUsed)])
  })

  it('refuses rather than cutting a sheet short, overflowing a cell or exceeding the cell cap', () => {
    const big = input(RISKY, RISKY_NEW)
    expect(() => buildXlsxReport(big, { ...LIMITS, maxSheetRows: 3 })).toThrow(/^The Summary sheet would have 16 rows; an .xlsx sheet holds 3\. Download the changes CSV/)
    const long = 'x'.repeat(MAX_CELL_CHARS + 1)
    expect(() => buildXlsxReport(input('id,note\n1,a\n', `id,note\n1,a\n2,${long}\n`), LIMITS)).toThrow(
      /^A value in the Added sheet, column "note", row 2, has 32,768 characters; an .xlsx cell holds 32,767\./,
    )
    expect(() => buildXlsxReport(big, { ...LIMITS, maxCells: 10 })).toThrow(ExportRefused)
  })
})
