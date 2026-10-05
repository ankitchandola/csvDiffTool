import { describe, expect, it } from 'vitest'
import { fixtureText, profile } from '../engine/fixtures.test-helper'
import { createHandler } from './handler'
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
    expect(result).toMatchObject({ ok: true, info: { headers: ['id', 'v'], recordCount: 50, delimiter: ',' } })
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

    expect(await handle({ id: 4, type: 'getRows', tab: 'added', offset: 1, limit: 10 })).toEqual({
      tab: 'added',
      total: 2,
      offset: 1,
      items: [{ key: { encoded: '["5"]', parts: ['5'] }, recordNumber: 4, row: { id: '5', v: 'e' } }],
    })
    expect(await handle({ id: 5, type: 'getRows', tab: 'removed', offset: 0, limit: 10 })).toMatchObject({
      total: 1,
      items: [{ recordNumber: 1, row: { id: '1', v: 'a' } }],
    })
    expect(await handle({ id: 6, type: 'getRows', tab: 'changed', offset: 0, limit: 10 })).toMatchObject({
      total: 1,
      items: [{ oldRecordNumber: 3, newRecordNumber: 2, changes: [{ column: 'v', before: 'c', after: 'z' }] }],
    })
  })

  it('caps the page size', async () => {
    const rows = Array.from({ length: MAX_PAGE_SIZE + 10 }, (_, i) => `${i},x`).join('\n')
    const handle = await loaded('id,v\n', `id,v\n${rows}\n`)
    await handle({ id: 3, type: 'compare', profile: profile({ columns: ['id'] }) })
    const page = await handle({ id: 4, type: 'getRows', tab: 'added', offset: 0, limit: 1_000_000 })
    expect(page).toMatchObject({ total: MAX_PAGE_SIZE + 10 })
    if ('items' in page) expect(page.items).toHaveLength(MAX_PAGE_SIZE)
  })

  it('drops the stored comparison when a file is replaced', async () => {
    const handle = await loaded('id,v\n1,a\n', 'id,v\n1,b\n')
    await handle({ id: 3, type: 'compare', profile: profile({ columns: ['id'] }) })
    await handle({ id: 4, type: 'parse', side: 'new', file: new File(['id,v\n1,c\n'], 'n.csv'), rules: RULES })
    await expect(handle({ id: 5, type: 'getRows', tab: 'changed', offset: 0, limit: 10 })).rejects.toThrow(
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

    const page = await handle({ id: 4, type: 'getRows', tab: 'emptyKey', offset: 100, limit: 50 })
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
    expect(await handle({ id: 4, type: 'getRows', tab: 'warnings', offset: 299, limit: 10 })).toMatchObject({
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

    const page = await handle({ id: 4, type: 'getRows', tab: 'changed', offset: 0, limit: 10, column: 'price' })
    expect(page).toMatchObject({ total: 2, items: [{ key: { parts: ['1'] } }, { key: { parts: ['3'] } }] })
    expect(await handle({ id: 5, type: 'getRows', tab: 'changed', offset: 0, limit: 10 })).toMatchObject({ total: 3 })
    expect(await handle({ id: 6, type: 'getRows', tab: 'changed', offset: 0, limit: 10, column: 'nope' })).toMatchObject({
      total: 0,
      items: [],
    })
  })
})
