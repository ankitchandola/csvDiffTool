import { describe, expect, it } from 'vitest'
import { fixtureText, profile } from '../engine/fixtures.test-helper'
import { createHandler } from './handler'
import { PREVIEW_RECORDS } from './protocol'

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
