import * as XLSX from 'xlsx'
import { describe, expect, it } from 'vitest'
import { fixtureText, profile } from '../engine/fixtures.test-helper'
import { createHandler, LEGACY_EXCEL_MESSAGE } from './handler'
import { DEFAULT_LIMITS, fileTooLargeMessage, tooManyFieldsMessage } from '../engine/limits'
import { NOT_UTF8_MESSAGE } from '../engine/parse'
import {
  MAX_GROUP_MEMBERS,
  MAX_PAGE_SIZE,
  PREVIEW_ISSUES,
  PREVIEW_PROBLEMS,
  PREVIEW_RECORDS,
  PREVIEW_WARNINGS,
} from './protocol'

const RULES = { delimiter: 'auto', trimHeaders: true } as const

function file(name: string, side: 'old' | 'new') {
  return new File([fixtureText(name, side)], `${side}.csv`, { type: 'text/csv' })
}

describe('worker handler', () => {
  it('returns file info with a bounded preview, not every row', async () => {
    const handle = createHandler()
    const rows = Array.from({ length: 50 }, (_, i) => `${i},x`).join('\n')
    const result = await handle({ id: 1, type: 'parse', side: 'old', file: new File([`id,v\n${rows}\n`], 'a.csv'), rules: RULES })
    expect(result).toMatchObject({ ok: true, info: { headers: ['id', 'v'], recordCount: 50, format: { kind: 'csv', delimiter: ',' }, notes: [] } })
    if ('ok' in result && result.ok) expect(result.info.preview).toHaveLength(PREVIEW_RECORDS)
  })

  it('reports key problems before comparison and the summary after', async () => {
    const handle = createHandler()
    await handle({ id: 1, type: 'parse', side: 'old', file: file('dup-in-new', 'old'), rules: RULES })
    await handle({ id: 2, type: 'parse', side: 'new', file: file('dup-in-new', 'new'), rules: RULES })

    const report = await handle({ id: 3, type: 'checkKeys', rules: { columns: ['id'], trim: true, caseInsensitive: false } })
    expect(report).toMatchObject({ counts: { matched: 1, added: 0, removed: 0 }, ambiguous: { total: 1 }, emptyKey: { total: 0 } })

    const compared = await handle({ id: 4, type: 'compare', profile: profile({ columns: ['id'] }) })
    expect(compared).toMatchObject({ summary: { counts: { ambiguous: 1, unchanged: 1 } } })
  })

  it('forgets a side whose new file fails to parse', async () => {
    const handle = createHandler()
    await handle({ id: 1, type: 'parse', side: 'old', file: file('reordered', 'old'), rules: RULES })
    await handle({ id: 2, type: 'parse', side: 'new', file: file('reordered', 'new'), rules: RULES })
    await handle({ id: 3, type: 'parse', side: 'new', file: file('malformed', 'new'), rules: RULES })
    await expect(handle({ id: 4, type: 'compare', profile: profile({ columns: ['id'] }) })).rejects.toThrow('Load both files first')
  })
})

describe('worker handler limits and paging', () => {
  async function loaded(oldText: string, newText: string) {
    const handle = createHandler()
    await handle({ id: 1, type: 'parse', side: 'old', file: new File([oldText], 'old.csv'), rules: RULES })
    await handle({ id: 2, type: 'parse', side: 'new', file: new File([newText], 'new.csv'), rules: RULES })
    return handle
  }

  it('caps the records listed inside one ambiguous key but keeps the totals', async () => {
    const dupes = Array.from({ length: 2000 }, (_, i) => `1,${i}`).join('\n')
    const handle = await loaded(`id,v\n${dupes}\n`, 'id,v\n1,a\n')
    const report = await handle({ id: 3, type: 'checkKeys', rules: { columns: ['id'], trim: true, caseInsensitive: false } })
    if (!('counts' in report)) throw new Error('expected a key report')
    expect(report.ambiguous.total).toBe(1)
    expect(report.ambiguous.items[0]).toMatchObject({ oldCount: 2000, newCount: 1 })
    expect(report.ambiguous.items[0].old).toHaveLength(MAX_GROUP_MEMBERS)
  })

  it('pages added, removed and changed records from the latest comparison', async () => {
    const handle = await loaded('id,v\n1,a\n2,b\n3,c\n', 'id,v\n2,b\n3,z\n4,d\n5,e\n')
    await handle({ id: 3, type: 'compare', profile: profile({ columns: ['id'] }) })

    expect(await handle({ id: 4, type: 'getRows', resultId: 1, tab: 'added', offset: 1, limit: 10 })).toEqual({
      tab: 'added',
      total: 2,
      offset: 1,
      items: [{ key: { encoded: '["5"]', parts: ['5'] }, recordNumber: 4, row: { id: '5', v: 'e' } }],
    })
    expect(await handle({ id: 5, type: 'getRows', resultId: 1, tab: 'removed', offset: 0, limit: 10 })).toMatchObject({
      total: 1,
      items: [{ recordNumber: 1, row: { id: '1', v: 'a' } }],
    })
    expect(await handle({ id: 6, type: 'getRows', resultId: 1, tab: 'changed', offset: 0, limit: 10 })).toMatchObject({
      total: 1,
      items: [{ oldRecordNumber: 3, newRecordNumber: 2, changes: [{ column: 'v', before: 'c', after: 'z' }] }],
    })
  })

  it('caps the page size', async () => {
    const rows = Array.from({ length: MAX_PAGE_SIZE + 10 }, (_, i) => `${i},x`).join('\n')
    const handle = await loaded('id,v\n', `id,v\n${rows}\n`)
    await handle({ id: 3, type: 'compare', profile: profile({ columns: ['id'] }) })
    const page = await handle({ id: 4, type: 'getRows', resultId: 1, tab: 'added', offset: 0, limit: 1_000_000 })
    expect(page).toMatchObject({ total: MAX_PAGE_SIZE + 10 })
    if ('items' in page) expect(page.items).toHaveLength(MAX_PAGE_SIZE)
  })

  it('drops the stored comparison when a file is replaced', async () => {
    const handle = await loaded('id,v\n1,a\n', 'id,v\n1,b\n')
    await handle({ id: 3, type: 'compare', profile: profile({ columns: ['id'] }) })
    await handle({ id: 4, type: 'parse', side: 'new', file: new File(['id,v\n1,c\n'], 'n.csv'), rules: RULES })
    await expect(handle({ id: 5, type: 'getRows', resultId: 1, tab: 'changed', offset: 0, limit: 10 })).rejects.toThrow(
      'Compare the files first',
    )
  })

  it('previews problem lists with their full totals and pages the rest', async () => {
    const empties = Array.from({ length: 120 }, () => ',x').join('\n')
    const handle = await loaded(`id,v\n${empties}\n`, 'id,v\n1,a\n')
    const compared = await handle({ id: 3, type: 'compare', profile: profile({ columns: ['id'] }) })
    if (!('summary' in compared)) throw new Error('expected a comparison')
    expect(compared.emptyKey.total).toBe(120)
    expect(compared.emptyKey.items).toHaveLength(PREVIEW_PROBLEMS)

    const page = await handle({ id: 4, type: 'getRows', resultId: 1, tab: 'emptyKey', offset: 100, limit: 50 })
    expect(page).toMatchObject({ total: 120, offset: 100 })
    if ('items' in page) expect(page.items).toHaveLength(20)
  })

  it('keeps every numeric warning and pages them', async () => {
    const oldRows = Array.from({ length: 150 }, (_, i) => `${i},N/A`).join('\n')
    const handle = await loaded(`id,price\n${oldRows}\n`, `id,price\n${oldRows}\n`)
    const numeric = { price: { tolerance: '0', stripThousandsSeparator: false } }
    const compared = await handle({ id: 3, type: 'compare', profile: profile({ columns: ['id'] }, { numeric }) })
    if (!('warnings' in compared)) throw new Error('expected a comparison')
    expect(compared.warnings).toMatchObject({ total: 300 })
    expect(compared.warnings.items).toHaveLength(PREVIEW_WARNINGS)
    expect(await handle({ id: 4, type: 'getRows', resultId: 1, tab: 'warnings', offset: 299, limit: 10 })).toMatchObject({
      total: 300,
      items: [{ side: 'new', recordNumber: 150 }],
    })
  })
})

describe('worker handler file diagnostics', () => {
  it('rejects a file that is not UTF-8 with an actionable message', async () => {
    const handle = createHandler()
    const latin1 = new File([new Uint8Array([0x69, 0x64, 0x0a, 0x63, 0x61, 0x66, 0xe9, 0x0a])], 'export.csv')
    const result = await handle({ id: 1, type: 'parse', side: 'old', file: latin1, rules: RULES })
    expect(result).toEqual({ ok: false, issues: { total: 1, items: [{ kind: 'file', message: NOT_UTF8_MESSAGE }] } })
  })

  it('previews parse issues and keeps all of them for paging', async () => {
    const handle = createHandler()
    const bad = new File(['a,b\n' + '1\n'.repeat(2340)], 'bad.csv')
    const result = await handle({ id: 1, type: 'parse', side: 'new', file: bad, rules: RULES })
    if (!('ok' in result) || result.ok) throw new Error('expected parse issues')
    expect(result.issues.total).toBe(2340)
    expect(result.issues.items).toHaveLength(PREVIEW_ISSUES)
    expect(await handle({ id: 2, type: 'getIssues', side: 'new', offset: 2339, limit: 5 })).toMatchObject({
      total: 2340,
      items: [{ kind: 'record', recordNumber: 2340 }],
    })
  })
})

describe('worker handler changed-record filter', () => {
  it('pages only records where the chosen column changed, with a matching total', async () => {
    const handle = createHandler()
    const oldText = 'id,price,stock\n1,1,1\n2,1,1\n3,1,1\n'
    const newText = 'id,price,stock\n1,2,1\n2,1,2\n3,2,2\n'
    await handle({ id: 1, type: 'parse', side: 'old', file: new File([oldText], 'o.csv'), rules: RULES })
    await handle({ id: 2, type: 'parse', side: 'new', file: new File([newText], 'n.csv'), rules: RULES })
    await handle({ id: 3, type: 'compare', profile: profile({ columns: ['id'] }) })

    const page = await handle({ id: 4, type: 'getRows', resultId: 1, tab: 'changed', offset: 0, limit: 10, column: 'price' })
    expect(page).toMatchObject({ total: 2, items: [{ key: { parts: ['1'] } }, { key: { parts: ['3'] } }] })
    expect(await handle({ id: 5, type: 'getRows', resultId: 1, tab: 'changed', offset: 0, limit: 10 })).toMatchObject({ total: 3 })
    expect(await handle({ id: 6, type: 'getRows', resultId: 1, tab: 'changed', offset: 0, limit: 10, column: 'nope' })).toMatchObject({
      total: 0,
      items: [],
    })
  })
})

describe('worker handler paging guarantees', () => {
  async function compared(oldText: string, newText: string, rules = profile({ columns: ['id'] })) {
    const handle = createHandler()
    await handle({ id: 1, type: 'parse', side: 'old', file: new File([oldText], 'o.csv'), rules: RULES })
    await handle({ id: 2, type: 'parse', side: 'new', file: new File([newText], 'n.csv'), rules: RULES })
    const result = await handle({ id: 3, type: 'compare', profile: rules })
    if (!('resultId' in result)) throw new Error('expected a comparison')
    return { handle, resultId: result.resultId }
  }

  async function pageThrough(
    handle: ReturnType<typeof createHandler>,
    request: { resultId: number; tab: 'added' | 'changed'; column?: string },
    limit: number,
  ) {
    const seen: string[] = []
    let total = Infinity
    for (let offset = 0; offset < total; offset += limit) {
      const page = await handle({ id: 9, type: 'getRows', offset, limit, ...request })
      if (!('items' in page)) throw new Error('expected a page')
      total = page.total
      for (const item of page.items) seen.push(JSON.stringify((item as { key: { parts: string[] } }).key.parts))
    }
    return { seen, total }
  }

  it('pages every record exactly once, in the same order on every pass', async () => {
    const rows = Array.from({ length: 1234 }, (_, i) => `${i},x`).join('\n')
    const { handle, resultId } = await compared('id,v\n', `id,v\n${rows}\n`)
    const first = await pageThrough(handle, { resultId, tab: 'added' }, 97)
    const second = await pageThrough(handle, { resultId, tab: 'added' }, 200)
    expect(first.seen).toHaveLength(1234)
    expect(new Set(first.seen).size).toBe(1234)
    expect(second.seen).toEqual(first.seen)
  })

  it('filters before paging, so every page holds only matches and the total is the filtered total', async () => {
    const ids = Array.from({ length: 900 }, (_, i) => i)
    const oldText = 'id,price,stock\n' + ids.map((i) => `${i},1,1`).join('\n') + '\n'
    // Every third record changes price; every record changes stock.
    const newText = 'id,price,stock\n' + ids.map((i) => `${i},${i % 3 === 0 ? 2 : 1},2`).join('\n') + '\n'
    const { handle, resultId } = await compared(oldText, newText)
    const { seen, total } = await pageThrough(handle, { resultId, tab: 'changed', column: 'price' }, 200)
    expect(total).toBe(300)
    expect(seen).toEqual(ids.filter((i) => i % 3 === 0).map((i) => JSON.stringify([String(i)])))
  })

  it('refuses pages for a comparison that has been replaced', async () => {
    const { handle, resultId } = await compared('id,v\n1,a\n', 'id,v\n1,b\n')
    const newer = await handle({ id: 4, type: 'compare', profile: profile({ columns: ['id'] }) })
    if (!('resultId' in newer)) throw new Error('expected a comparison')
    expect(newer.resultId).not.toBe(resultId)
    await expect(handle({ id: 5, type: 'getRows', resultId, tab: 'changed', offset: 0, limit: 10 })).rejects.toThrow(
      'replaced by a newer comparison',
    )
    expect(
      await handle({ id: 6, type: 'getRows', resultId: newer.resultId, tab: 'changed', offset: 0, limit: 10 }),
    ).toMatchObject({ total: 1 })
  })

  it('pages every record of a large ambiguous group, not just the first ten', async () => {
    const dupes = Array.from({ length: 25 }, (_, i) => `7,${i}`).join('\n')
    const { handle, resultId } = await compared(`id,v\n${dupes}\n`, 'id,v\n7,a\n')
    const page = await handle({ id: 4, type: 'getRows', resultId, tab: 'ambiguous', offset: 20, limit: 100 })
    expect(page).toMatchObject({ total: 26, offset: 20 })
    if ('items' in page) {
      expect(page.items).toHaveLength(6)
      expect(page.items.at(-1)).toEqual({ encoded: '["7"]', side: 'new', recordNumber: 1, parts: ['7'], oldCount: 25, newCount: 1 })
    }
  })

  it('returns both the new and the old key as typed for a changed record', async () => {
    const { handle, resultId } = await compared(
      'sku,qty\nABC ,1\n',
      'sku,qty\nabc,2\n',
      profile({ columns: ['sku'], caseInsensitive: true }),
    )
    expect(await handle({ id: 4, type: 'getRows', resultId, tab: 'changed', offset: 0, limit: 10 })).toMatchObject({
      items: [{ key: { parts: ['abc'] }, oldKeyParts: ['ABC '] }],
    })
  })
})

describe('worker handler export', () => {
  it('exports the latest comparison as a changes CSV and a JSON report naming the files', async () => {
    const handle = createHandler()
    await handle({ id: 1, type: 'parse', side: 'old', file: new File(['id,v\n1,a\n'], 'monday.csv'), rules: RULES })
    await handle({ id: 2, type: 'parse', side: 'new', file: new File(['id,v\n1,b\n'], 'tuesday.csv'), rules: RULES })
    const result = await handle({ id: 3, type: 'compare', profile: profile({ columns: ['id'] }) })
    if (!('resultId' in result)) throw new Error('expected a comparison')

    const csv = await handle({ id: 4, type: 'export', resultId: result.resultId, format: 'csv' })
    if (!(csv instanceof Blob)) throw new Error('expected a Blob')
    // Blob.text() drops a BOM while decoding, so check the bytes for it.
    expect([...new Uint8Array(await csv.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(await csv.text()).toBe('change_type,key,column,before,after\r\nchanged,1,v,a,b\r\n')

    const json = await handle({ id: 5, type: 'export', resultId: result.resultId, format: 'json' })
    if (!(json instanceof Blob)) throw new Error('expected a Blob')
    expect(JSON.parse(await json.text())).toMatchObject({ files: { old: 'monday.csv', new: 'tuesday.csv' } })

    await expect(handle({ id: 6, type: 'export', resultId: result.resultId + 1, format: 'csv' })).rejects.toThrow(
      'replaced by a newer comparison',
    )
  })
})

describe('worker handler formula escaping', () => {
  it('escapes only the CSV download and leaves the stored comparison untouched', async () => {
    const handle = createHandler()
    await handle({ id: 1, type: 'parse', side: 'old', file: new File(['id,v\n1,a\n'], 'o.csv'), rules: RULES })
    await handle({ id: 2, type: 'parse', side: 'new', file: new File(['id,v\n1,=HYPERLINK("x")\n'], 'n.csv'), rules: RULES })
    const result = await handle({ id: 3, type: 'compare', profile: profile({ columns: ['id'] }) })
    if (!('resultId' in result)) throw new Error('expected a comparison')
    const { resultId } = result

    const csv = await handle({ id: 4, type: 'export', resultId, format: 'csv' })
    if (!(csv instanceof Blob)) throw new Error('expected a Blob')
    expect(await csv.text()).toContain(`"'=HYPERLINK(""x"")"`)

    const raw = await handle({ id: 5, type: 'export', resultId, format: 'csv', escapeFormulae: false })
    if (!(raw instanceof Blob)) throw new Error('expected a Blob')
    expect(await raw.text()).toContain('"=HYPERLINK(""x"")"')

    expect(await handle({ id: 6, type: 'getRows', resultId, tab: 'changed', offset: 0, limit: 10 })).toMatchObject({
      items: [{ changes: [{ column: 'v', before: 'a', after: '=HYPERLINK("x")' }] }],
    })
    const json = await handle({ id: 7, type: 'export', resultId, format: 'json' })
    if (!(json instanceof Blob)) throw new Error('expected a Blob')
    expect(JSON.parse(await json.text()).changed[0].changes[0].after).toBe('=HYPERLINK("x")')
  })
})

describe('worker handler size limits', () => {
  it('rejects a file over the byte limit without reading it', async () => {
    const handle = createHandler({ ...DEFAULT_LIMITS, maxFileBytes: 10, maxFields: 1_000 })
    const file = new File(['id,v\n1,abcdefgh\n'], 'big.csv')
    let read = false
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => {
        read = true
        return Promise.resolve(new ArrayBuffer(0))
      },
    })
    const result = await handle({ id: 1, type: 'parse', side: 'old', file, rules: RULES })
    expect(result).toEqual({
      ok: false,
      issues: { total: 1, items: [{ kind: 'file', message: fileTooLargeMessage(file.size, 10) }] },
    })
    expect(read).toBe(false)
    expect(fileTooLargeMessage(300 * 2 ** 20, 200 * 2 ** 20)).toMatch('This file is 300 MiB; the limit is 200 MiB per file')
  })

  it('rejects a file over the field limit', async () => {
    const handle = createHandler({ ...DEFAULT_LIMITS, maxFileBytes: 1_000, maxFields: 3 })
    const result = await handle({ id: 1, type: 'parse', side: 'old', file: new File(['a,b\n1,2\n3,4\n'], 'f.csv'), rules: RULES })
    expect(result).toMatchObject({ ok: false, issues: { items: [{ kind: 'file', message: tooManyFieldsMessage(3) }] } })
  })
})

describe('worker handler .xlsx input', () => {
  function xlsx(rows: unknown[][], edit?: (sheet: XLSX.WorkSheet) => void): File {
    const book = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet(rows)
    edit?.(sheet)
    XLSX.utils.book_append_sheet(book, sheet, 'Data')
    return new File([XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer], 'book.xlsx')
  }

  it('compares an .xlsx against a CSV export of the same sheet as equal', async () => {
    const handle = createHandler()
    const book = xlsx([['id', 'price'], ['1', 1234.5]], (s) => {
      s['B2'].z = '#,##0.00'
    })
    const parsed = await handle({ id: 1, type: 'parse', side: 'old', file: book, rules: RULES })
    expect(parsed).toMatchObject({ ok: true, info: { format: { kind: 'xlsx', sheet: 'Data', sheets: ['Data'] } } })
    await handle({ id: 2, type: 'parse', side: 'new', file: new File(['id,price\n1,"1,234.50"\n'], 'new.csv'), rules: RULES })
    const compared = await handle({ id: 3, type: 'compare', profile: profile({ columns: ['id'] }) })
    expect(compared).toMatchObject({ summary: { counts: { changed: 0, unchanged: 1 } } })
  })

  it('rejects an old .xls or encrypted workbook with a save-as hint', async () => {
    const handle = createHandler()
    const ole = new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])], 'old.xls')
    expect(await handle({ id: 1, type: 'parse', side: 'old', file: ole, rules: RULES })).toEqual({
      ok: false,
      issues: { total: 1, items: [{ kind: 'file', message: LEGACY_EXCEL_MESSAGE }] },
    })
  })

  it('applies the smaller .xlsx byte limit', async () => {
    const handle = createHandler({ ...DEFAULT_LIMITS, maxXlsxBytes: 10 })
    const book = xlsx([['id'], ['1']])
    expect(await handle({ id: 1, type: 'parse', side: 'old', file: book, rules: RULES })).toEqual({
      ok: false,
      issues: { total: 1, items: [{ kind: 'file', message: fileTooLargeMessage(book.size, 10) }] },
    })
  })
})

describe('worker handler .xlsx export', () => {
  it('builds the workbook from the stored result and refuses past the cell cap', async () => {
    const run = async (maxXlsxExportCells: number) => {
      const handle = createHandler({ ...DEFAULT_LIMITS, maxXlsxExportCells })
      await handle({ id: 1, type: 'parse', side: 'old', file: new File(['id,v\n1,0007\n'], 'old.csv'), rules: RULES })
      await handle({ id: 2, type: 'parse', side: 'new', file: new File(['id,v\n1,0008\n'], 'new.csv'), rules: RULES })
      const compared = await handle({ id: 3, type: 'compare', profile: profile({ columns: ['id'] }) })
      if (!('resultId' in compared)) throw new Error('no result')
      return handle({ id: 4, type: 'export', resultId: compared.resultId, format: 'xlsx' })
    }
    const blob = await run(DEFAULT_LIMITS.maxXlsxExportCells)
    if (!(blob instanceof Blob)) throw new Error('expected a Blob')
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    const book = XLSX.read(await blob.arrayBuffer(), { type: 'array' })
    expect(XLSX.utils.sheet_to_json(book.Sheets.Changed, { header: 1 })).toEqual([
      ['Key: id', 'Old record', 'New record', 'Column', 'Before', 'After'],
      ['1', '1', '1', 'v', '0007', '0008'],
    ])
    await expect(run(10)).rejects.toThrow(/the .xlsx export is limited to 10 cells/)
  })
})

describe('worker handler result search', () => {
  async function compared() {
    const handle = createHandler()
    const oldText = 'id,name,city\n1,Apple,Pune\n2,Pear,Delhi\n3,Plum,Goa\n4,Fig,Pune\n'
    const newText = 'id,name,city\n1,Apple,Mumbai\n2,PEAR,Delhi\n3,Plum,Goa\n5,Kiwi,Pune\n'
    await handle({ id: 1, type: 'parse', side: 'old', file: new File([oldText], 'old.csv'), rules: RULES })
    await handle({ id: 2, type: 'parse', side: 'new', file: new File([newText], 'new.csv'), rules: RULES })
    const result = await handle({ id: 3, type: 'compare', profile: profile({ columns: ['id'] }) })
    if (!('resultId' in result)) throw new Error('no result')
    const rows = (tab: 'changed' | 'added' | 'removed', search?: string, column?: string) =>
      handle({ id: 4, type: 'getRows', resultId: result.resultId, tab, offset: 0, limit: 50, search, column }) as Promise<{
        total: number
        items: { key: { parts: string[] } }[]
      }>
    return rows
  }

  const keys = (page: { items: { key: { parts: string[] } }[] }) => page.items.map((item) => item.key.parts[0])

  it('finds changed records by before or after value, ignoring case', async () => {
    const rows = await compared()
    expect(keys(await rows('changed', 'mumbai'))).toEqual(['1'])
    expect(keys(await rows('changed', 'pune'))).toEqual(['1'])
    expect(keys(await rows('changed', 'pear'))).toEqual(['2'])
  })

  it('finds by key, column name and any field of added or removed records', async () => {
    const rows = await compared()
    expect(keys(await rows('changed', '2'))).toEqual(['2'])
    expect(keys(await rows('changed', 'city'))).toEqual(['1'])
    expect(keys(await rows('added', 'kiwi'))).toEqual(['5'])
    expect(keys(await rows('removed', 'PUNE'))).toEqual(['4'])
  })

  it('searches the full tab before paging and combines with the column filter', async () => {
    const rows = await compared()
    expect((await rows('changed', 'e', 'name')).total).toBe(1)
    expect((await rows('changed', 'e')).total).toBe(2)
    expect((await rows('changed', '   ')).total).toBe(2)
    expect((await rows('changed', 'nothing-matches')).total).toBe(0)
  })
})
