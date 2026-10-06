import * as XLSX from 'xlsx'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS } from './limits'
import { NOT_XLSX_MESSAGE, parseXlsx } from './xlsx'
import { unpackedSize } from './zip'

type Sheet = { name: string; rows: unknown[][]; edit?: (sheet: XLSX.WorkSheet) => void }

function workbook(...sheets: Sheet[]): ArrayBuffer {
  const book = XLSX.utils.book_new()
  for (const { name, rows, edit } of sheets) {
    const sheet = XLSX.utils.aoa_to_sheet(rows)
    edit?.(sheet)
    XLSX.utils.book_append_sheet(book, sheet, name)
  }
  return XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

function parsed(bytes: ArrayBuffer, sheet?: string) {
  const outcome = parseXlsx(bytes, sheet, DEFAULT_LIMITS)
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
  return outcome.file
}

describe('parseXlsx', () => {
  it('reads cells as Excel displays them', () => {
    const bytes = workbook({
      name: 'Prices',
      rows: [
        ['sku', 'price', 'since', 'code'],
        ['A1', 1234.5, 45567, '0007'],
      ],
      edit: (s) => {
        s['B2'].z = '#,##0.00'
        s['C2'].z = 'yyyy-mm-dd'
      },
    })
    const file = parsed(bytes)
    expect(file.headers).toEqual(['sku', 'price', 'since', 'code'])
    expect(file.rows).toEqual([{ sku: 'A1', price: '1,234.50', since: '2024-10-02', code: '0007' }])
    expect(file.format).toEqual({ kind: 'xlsx', sheet: 'Prices', sheets: ['Prices'] })
  })

  it('keeps zeros a number format adds, as displayed', () => {
    const bytes = workbook({
      name: 'S',
      rows: [['code'], [7]],
      edit: (s) => {
        s['A2'].z = '0000'
      },
    })
    expect(parsed(bytes).rows).toEqual([{ code: '0007' }])
  })

  it('reports a formula with no saved result instead of reading it as empty', () => {
    const bytes = workbook({
      name: 'S',
      rows: [['id', 'total'], ['1', 10], ['2', 0]],
      edit: (s) => {
        s['B3'] = { t: 'n', f: 'A3*10' }
      },
    })
    expect(parseXlsx(bytes, undefined, DEFAULT_LIMITS)).toMatchObject({
      ok: false,
      issues: [
        {
          kind: 'record',
          recordNumber: 2,
          message: 'Column "total" has a formula (=A3*10) with no saved result. Open the workbook in Excel and save it so results are stored.',
          raw: '2, ',
        },
      ],
    })
  })

  it('reads saved formula results of "", 0 and FALSE as values, not as missing', () => {
    const bytes = workbook({
      name: 'S',
      rows: [['id', 'text', 'number', 'flag'], ['1', 'x', 5, true]],
      edit: (s) => {
        s['B2'] = { t: 's', f: '""', v: '' }
        s['C2'] = { t: 'n', f: '0*1', v: 0 }
        s['D2'] = { t: 'b', f: '1=2', v: false }
      },
    })
    expect(parsed(bytes).rows).toEqual([{ id: '1', text: '', number: '0', flag: 'FALSE' }])
  })

  it('takes the first non-blank row of the used range as the header', () => {
    const file = parsed(workbook({ name: 'S', rows: [[], [], ['id', 'v'], ['1', 'x']] }))
    expect(file.headers).toEqual(['id', 'v'])
    expect(file.rows).toEqual([{ id: '1', v: 'x' }])
  })

  it('returns the sheet list with a failed sheet so another can be picked', () => {
    const bytes = workbook({ name: 'Notes', rows: [['a', 'a'], ['1', '2']] }, { name: 'Data', rows: [['id'], ['1']] })
    expect(parseXlsx(bytes, undefined, DEFAULT_LIMITS)).toMatchObject({
      ok: false,
      format: { kind: 'xlsx', sheet: 'Notes', sheets: ['Notes', 'Data'] },
    })
  })

  it('stops parsing at the field limit instead of checking after a full read', () => {
    const rows = [['id', 'v'], ...Array.from({ length: 50 }, (_, i) => [String(i), 'x'])]
    const outcome = parseXlsx(workbook({ name: 'S', rows }), undefined, { ...DEFAULT_LIMITS, maxXlsxFields: 20 })
    expect(outcome.ok === false && outcome.issues[0].message).toMatch(/more than 20 fields/)
  })

  it('rechecks at the header width when the declared range has extra empty columns', () => {
    const bytes = workbook({
      name: 'S',
      rows: [['id', 'v'], ['1', 'x'], ['2', 'y']],
      edit: (s) => {
        s['!ref'] = 'A1:D3'
      },
    })
    expect(parseXlsx(bytes, undefined, { ...DEFAULT_LIMITS, maxXlsxFields: 4 }).ok).toBe(true)
    expect(parseXlsx(bytes, undefined, { ...DEFAULT_LIMITS, maxXlsxFields: 3 }).ok).toBe(false)
  })

  it('fills short rows and ignores empty columns past the last header', () => {
    const file = parsed(workbook({ name: 'S', rows: [['id', 'a', 'b', ''], ['1'], ['2', 'x', 'y', '']] }))
    expect(file.headers).toEqual(['id', 'a', 'b'])
    expect(file.rows).toEqual([
      { id: '1', a: '', b: '' },
      { id: '2', a: 'x', b: 'y' },
    ])
  })

  it('rejects a value outside the named columns as a record problem', () => {
    const outcome = parseXlsx(workbook({ name: 'S', rows: [['id', 'a'], ['1', 'x'], ['2', 'y', 'stray']] }), undefined, DEFAULT_LIMITS)
    expect(outcome).toMatchObject({
      ok: false,
      issues: [{ kind: 'record', recordNumber: 2, message: 'Has values beyond the 2 named columns', raw: '2, y, stray' }],
    })
  })

  it('reads the chosen sheet and lists them all', () => {
    const bytes = workbook({ name: 'Summary', rows: [['x'], ['1']] }, { name: 'Data', rows: [['id'], ['7']] })
    expect(parsed(bytes).format).toEqual({ kind: 'xlsx', sheet: 'Summary', sheets: ['Summary', 'Data'] })
    expect(parsed(bytes, 'Data').rows).toEqual([{ id: '7' }])
    expect(parseXlsx(bytes, 'Missing', DEFAULT_LIMITS)).toEqual({
      ok: false,
      issues: [{ kind: 'file', message: 'This workbook has no sheet named "Missing".' }],
    })
  })

  it('notes merged cells and hidden rows and columns', () => {
    const bytes = workbook({
      name: 'S',
      rows: [['id', 'a', 'b'], ['1', 'x', 'y'], ['2', 'z', 'w']],
      edit: (s) => {
        s['!merges'] = [{ s: { r: 1, c: 1 }, e: { r: 1, c: 2 } }]
        s['!rows'] = [{}, {}, { hidden: true }]
        s['!cols'] = [{}, { hidden: true }]
      },
    })
    expect(parsed(bytes).notes).toEqual([
      '1 merged range: each value is read from its top-left cell only.',
      '1 hidden row included.',
      '1 hidden column included.',
    ])
  })

  it('reports header problems and empty sheets like CSV does', () => {
    expect(parseXlsx(workbook({ name: 'S', rows: [['id', 'id'], ['1', '2']] }), undefined, DEFAULT_LIMITS)).toMatchObject({
      ok: false,
      issues: [{ kind: 'header', message: 'Header "id" appears more than once' }],
    })
    expect(parseXlsx(workbook({ name: 'S', rows: [] }), undefined, DEFAULT_LIMITS)).toMatchObject({
      ok: false,
      issues: [{ kind: 'header', message: 'Sheet "S" is empty' }],
    })
  })

  it('enforces the field and unpacked-size limits', () => {
    const bytes = workbook({ name: 'S', rows: [['id', 'a'], ['1', 'x'], ['2', 'y']] })
    expect(parseXlsx(bytes, undefined, { ...DEFAULT_LIMITS, maxXlsxFields: 3 }).ok).toBe(false)
    expect(parseXlsx(bytes, undefined, { ...DEFAULT_LIMITS, maxXlsxFields: 4 }).ok).toBe(true)
    const unpacked = parseXlsx(bytes, undefined, { ...DEFAULT_LIMITS, maxUnpackedBytes: 100 })
    expect(unpacked.ok === false && unpacked.issues[0].message).toMatch(/unpacks to more than/)
  })

  it('rejects bytes that are not a workbook', () => {
    const bytes = new TextEncoder().encode('id,a\n1,x\n').buffer
    expect(parseXlsx(bytes, undefined, DEFAULT_LIMITS)).toEqual({ ok: false, issues: [{ kind: 'file', message: NOT_XLSX_MESSAGE }] })
  })
})

describe('unpackedSize', () => {
  it('sums the sizes the central directory lists', () => {
    const size = unpackedSize(workbook({ name: 'S', rows: [['id'], ['1']] }))
    expect(size).toBeGreaterThan(0)
  })

  it('returns null for bytes without a central directory', () => {
    expect(unpackedSize(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]).buffer)).toBeNull()
  })
})
