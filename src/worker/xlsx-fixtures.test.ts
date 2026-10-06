import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { profile } from '../engine/fixtures.test-helper'
import type { NumericRule } from '../engine/types'
import { createHandler } from './handler'

// Workbooks written by XlsxWriter (fixtures/xlsxwriter/generate.py), a different writer
// from the SheetJS-built ones elsewhere, with some cells edited to drop saved results.
const RULES = { delimiter: 'auto', trimHeaders: true } as const

function fixture(name: string): File {
  return new File([readFileSync(new URL(`../../fixtures/xlsxwriter/${name}`, import.meta.url))], name)
}

async function load(oldName: string, newName: string, sheets: { old?: string; new?: string } = {}) {
  const handle = createHandler()
  const parsed = {
    old: await handle({ id: 1, type: 'parse', side: 'old', file: fixture(oldName), rules: RULES, sheet: sheets.old }),
    new: await handle({ id: 2, type: 'parse', side: 'new', file: fixture(newName), rules: RULES, sheet: sheets.new }),
  }
  const compare = (numeric: Record<string, NumericRule> = {}) =>
    handle({ id: 3, type: 'compare', profile: profile({ columns: ['id'] }, { numeric }) })
  return { parsed, compare }
}

function messages(result: unknown): string[] {
  const outcome = result as { ok: boolean; issues?: { items: { message: string }[] } }
  return outcome.ok ? [] : (outcome.issues?.items.map((issue) => issue.message) ?? [])
}

describe('XlsxWriter workbooks', () => {
  it('match their CSV, including saved 0, FALSE and empty-string formula results', async () => {
    for (const name of ['formatted.xlsx', 'formatted-str.xlsx']) {
      const { compare } = await load(name, 'formatted.csv')
      expect(await compare()).toMatchObject({ summary: { counts: { changed: 0, unchanged: 2 }, warningCount: 0 } })
    }
  })

  it('note the untyped empty-string results XlsxWriter writes', async () => {
    const { parsed } = await load('formatted.xlsx', 'formatted-str.xlsx')
    expect(parsed.old).toMatchObject({ ok: true, info: { notes: [expect.stringMatching(/^2 formula cells saved an empty result with no type/)] } })
    expect(parsed.new).toMatchObject({ ok: true, info: { notes: [] } })
  })

  it('warn, without changes, when currency and percent text meets numeric rules', async () => {
    const { compare } = await load('formatted.csv', 'formatted.xlsx')
    const rule = { tolerance: '0', stripThousandsSeparator: true }
    expect(await compare({ currency: rule, percent: rule })).toMatchObject({ summary: { counts: { changed: 0 }, warningCount: 8 } })
  })

  it('find the known changes between two workbooks', async () => {
    const { compare } = await load('old.xlsx', 'new.xlsx')
    expect(await compare()).toMatchObject({ summary: { counts: { added: 1, removed: 1, changed: 1, unchanged: 1 } } })
  })

  it('reject a formula with no saved result instead of comparing it as empty', async () => {
    const { parsed } = await load('multi.xlsx', 'multi.csv')
    expect(messages(parsed.old)).toEqual([
      'Column "value" has a formula (=1+1) with no saved result. Open the workbook in Excel and save it so results are stored.',
    ])
  })

  it('reject a row holding only such a formula instead of skipping it', async () => {
    const { parsed } = await load('missing-only-row.xlsx', 'multi.csv')
    expect(messages(parsed.old)).toEqual([
      'Column "id" has a formula (=1) with no saved result. Open the workbook in Excel and save it so results are stored.',
    ])
  })

  it('name a header formula with no saved result', async () => {
    const { parsed } = await load('missing-header.xlsx', 'multi.csv')
    expect(messages(parsed.old)).toEqual([
      'Header column 1 has a formula (="id") with no saved result. Open the workbook in Excel and save it so results are stored.',
    ])
  })

  it('read the valid sheet beside a broken one, with its notes', async () => {
    for (const name of ['multi.xlsx', 'multi-invalid.xlsx']) {
      const { parsed, compare } = await load(name, 'multi.csv', { old: 'Valid' })
      expect(parsed.old).toMatchObject({ ok: true, info: { notes: ['1 merged range: each value is read from its top-left cell only.', '1 hidden row included.'] } })
      expect(await compare()).toMatchObject({ summary: { counts: { changed: 0, unchanged: 3 } } })
    }
  })

  it('reject values beyond the header and an oversized declared unpacked size', async () => {
    expect(messages((await load('extra.xlsx', 'multi.csv')).parsed.old)).toEqual(['Has values beyond the 2 named columns'])
    expect(messages((await load('declared-unpacked.xlsx', 'multi.csv')).parsed.old)[0]).toMatch(/unpacks to more than 256 MiB/)
  })
})
