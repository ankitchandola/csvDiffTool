import { describe, expect, it } from 'vitest'
import { fixtureText, profile } from '../engine/fixtures.test-helper'
import { createHandler } from './handler'
import { MAX_GROUP_MEMBERS, MAX_PAGE_SIZE, PREVIEW_RECORDS } from './protocol'

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
    expect(report).toMatchObject({ counts: { matched: 1, added: 0, removed: 0, ambiguous: 1, emptyKey: 0 } })

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
    expect(report.ambiguous[0]).toMatchObject({ oldCount: 2000, newCount: 1 })
    expect(report.ambiguous[0].old).toHaveLength(MAX_GROUP_MEMBERS)
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
})
