import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { describe, expect, it } from 'vitest'
import { diffFiles } from './diff'
import { profile } from './fixtures.test-helper'
import { parseCsv } from './parse'
import type { ReportInput } from './report'
import type { CompareProfile } from './types'
import { buildXlsxReport, ExportRefused, MAX_CELL_CHARS, MAX_SHEET_COLUMNS, MAX_SHEET_ROWS, type XlsxExportLimits } from './xlsx-report'

const LIMITS: XlsxExportLimits = {
  maxSheetRows: MAX_SHEET_ROWS,
  maxSheetColumns: MAX_SHEET_COLUMNS,
  maxCellChars: MAX_CELL_CHARS,
  maxCells: 1_000_000,
  maxTextChars: 10_000_000,
}

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

  it('refuses past every Excel and memory limit, naming where', () => {
    const big = input(RISKY, RISKY_NEW)
    expect(() => buildXlsxReport(big, { ...LIMITS, maxSheetRows: 3 })).toThrow(
      /^The Summary sheet would have \d+ rows; an .xlsx sheet holds 3\. Download the changes CSV/,
    )
    expect(() => buildXlsxReport(big, { ...LIMITS, maxSheetColumns: 5 })).toThrow(
      /^The Added sheet would have 6 columns; an .xlsx sheet holds 5\./,
    )
    const long = 'x'.repeat(MAX_CELL_CHARS + 1)
    expect(() => buildXlsxReport(input('id,note\n1,a\n', `id,note\n1,a\n2,${long}\n`), LIMITS)).toThrow(
      /^Cell Added!C2 \(column "note", record 2\) has 32,768 characters; an .xlsx cell holds 32,767\./,
    )
    expect(() => buildXlsxReport(big, { ...LIMITS, maxCells: 10 })).toThrow(ExportRefused)
    expect(() => buildXlsxReport(big, { ...LIMITS, maxCells: 10 })).toThrow(/needs \d+ cells; the .xlsx export is limited to 10 cells/)
    expect(() => buildXlsxReport(big, { ...LIMITS, maxTextChars: 100 })).toThrow(/characters of text; the .xlsx export is limited to 100/)
  })

  it('counts the generated Record column against the column limit', () => {
    const headers = Array.from({ length: 5 }, (_, i) => `c${i}`)
    const text = (rows: string[]) => [headers.join(','), ...rows].join('\n') + '\n'
    const report = input(text(['1,a,b,c,d']), text(['1,a,b,c,d', '2,a,b,c,d']), profile({ columns: ['c0'] }))
    expect(() => buildXlsxReport(report, { ...LIMITS, maxSheetColumns: 5 })).toThrow(/Added sheet would have 6 columns/)
    expect(() => buildXlsxReport(report, { ...LIMITS, maxSheetColumns: 6 })).not.toThrow()
  })

  it('names the Summary item or header when they are too long', () => {
    const report = input(RISKY, RISKY_NEW)
    expect(() => buildXlsxReport({ ...report, oldName: 'x'.repeat(40) }, { ...LIMITS, maxCellChars: 39 })).toThrow(
      /^Cell Summary!B2 \(column "Value", item "Old file"\) has 40 characters/,
    )
    const wide = `id,${'h'.repeat(300)}\n1,a\n`
    expect(() => buildXlsxReport(input(wide, `${wide}2,b\n`), { ...LIMITS, maxCellChars: 299 })).toThrow(
      /^Cell Added!C1 \(the header of column 3\) has 300 characters/,
    )
  })

  it('preserves awkward text exactly', () => {
    const values = [
      '  padded  ',
      'tab\there',
      'two\nlines',
      'emoji 🧾 and ₹ ü',
      '_x0041_',
      "'quoted",
      '',
      '=HYPERLINK("http://x")',
      '+1',
      '@SUM(A1)',
      '\u0001control',
      '_x005F_ already escaped',
    ]
    const csv = (rows: string[][]) => Papa.unparse(rows, { newline: '\n' })
    const oldText = csv([['id', 'v'], ...values.map((_, i) => [String(i), 'old'])])
    const newText = csv([['id', 'v'], ...values.map((v, i) => [String(i), v])])
    const report = input(oldText + '\n', newText + '\n', profile({ columns: ['id'] }))
    const bytes = buildXlsxReport(report, LIMITS)
    const changed = read(bytes).Sheets.Changed
    const after = values.map((_, i) => changed[XLSX.utils.encode_cell({ r: i + 1, c: 5 })])
    expect(after.map((cell) => cell?.v ?? '')).toEqual(values)
  })

  // SheetJS's reader drops an escaped carriage return, so this checks the written XML.
  it('escapes a carriage return inside a value rather than letting XML normalize it', () => {
    const bytes = buildXlsxReport(input('id,v\n1,a\n', 'id,v\n1,"crlf\r\nline"\n'), LIMITS)
    const zip = XLSX.CFB.read(new Uint8Array(bytes), { type: 'array' })
    const strings = new TextDecoder().decode(
      zip.FileIndex[zip.FullPaths.findIndex((path: string) => path.endsWith('xl/sharedStrings.xml'))].content as Uint8Array,
    )
    expect(strings).toMatch(/crlf_x000d_\nline/i)
  })

  it('writes shared-string cells only, with no formula elements, and keeps Excel text indicators', () => {
    const bytes = buildXlsxReport(input(RISKY, RISKY_NEW), LIMITS)
    const zip = XLSX.CFB.read(new Uint8Array(bytes), { type: 'array' })
    const sheets = zip.FullPaths.map((path: string, i: number) => [path, zip.FileIndex[i]] as const).filter(([path]: readonly [string, unknown]) =>
      /xl\/worksheets\/sheet\d+\.xml$/.test(path),
    )
    expect(sheets).toHaveLength(7)
    for (const [path, entry] of sheets) {
      const xml = new TextDecoder().decode(entry.content as Uint8Array)
      expect(xml, path).not.toContain('<f>')
      expect(xml, path).not.toContain('<f ')
      expect(xml, path).not.toContain('ignoredErrors')
      const types = [...xml.matchAll(/<c r="[A-Z]+\d+"([^>]*)>/g)].map((m) => /t="([^"]+)"/.exec(m[1])?.[1])
      expect(new Set(types), path).toEqual(new Set(['s']))
    }
  })

  it('names the compared worksheets of .xlsx inputs and says values are original text', () => {
    const report = input(RISKY, RISKY_NEW)
    report.oldFile = { ...report.oldFile, format: { kind: 'xlsx', sheet: 'March', sheets: ['Notes', 'March'] } }
    const summary = rows(read(buildXlsxReport(report, LIMITS)), 'Summary')
    expect(summary.slice(0, 3)).toEqual([
      ['Item', 'Value'],
      ['Old file', 'old.csv'],
      ['Old sheet', 'March'],
    ])
    expect(summary.find(([item, value]) => item === 'Note' && value.startsWith("Values are each file's original text"))).toBeDefined()
  })
})
