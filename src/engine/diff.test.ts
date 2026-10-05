import { describe, expect, it } from 'vitest'
import { diffFiles, formatSummary } from './diff'
import { parsedFixture, profile } from './fixtures.test-helper'
import type { CompareProfile } from './types'
import { RulesError } from './values'

function diff(name: string, p: CompareProfile) {
  return diffFiles(parsedFixture(name, 'old'), parsedFixture(name, 'new'), p)
}

describe('diffFiles', () => {
  it('reports no changes for reordered identical files', () => {
    const { summary } = diff('reordered', profile({ columns: ['id'] }))
    expect(summary.counts).toEqual({ added: 0, removed: 0, changed: 0, unchanged: 3, ambiguous: 0, emptyKey: 0 })
    expect(formatSummary(summary)).toBe('0 added, 0 removed, 0 changed.')
  })

  it('compares leading zeros as text', () => {
    const { changed } = diff('leading-zeros', profile({ columns: ['sku'] }))
    expect(changed).toEqual([
      { key: { encoded: '["00123"]', parts: ['00123'] }, oldIndex: 0, newIndex: 0, changes: [{ column: 'code', before: '0007', after: '7' }] },
    ])
  })

  it('treats numeric formatting differences as changes unless the column is numeric', () => {
    const plain = diff('numeric', profile({ columns: ['id'] }))
    expect(plain.summary.changesByColumn).toEqual({ price: 1, stock: 2 })
    expect(plain.summary.warningCount).toBe(0)
  })

  it('compares numeric columns as decimals and warns on unparseable values', () => {
    const { summary, changed } = diff(
      'numeric',
      profile(
        { columns: ['id'] },
        {
          numeric: {
            price: { tolerance: '0', stripThousandsSeparator: false },
            stock: { tolerance: '0', stripThousandsSeparator: true },
          },
        },
      ),
    )
    expect(changed.map((c) => c.key.parts)).toEqual([['3']])
    expect(formatSummary(summary)).toBe('0 added, 0 removed, 1 changed (stock: 1).')
    expect(summary.warnings).toEqual([
      { column: 'stock', side: 'old', recordNumber: 2, message: '"N/A" is not a number; compared as text' },
      { column: 'stock', side: 'new', recordNumber: 2, message: '"N/A" is not a number; compared as text' },
    ])
  })

  it('applies tolerance inclusively at the boundary', () => {
    const { changed } = diff(
      'tolerance',
      profile({ columns: ['id'] }, { numeric: { price: { tolerance: '0.01', stripThousandsSeparator: false } } }),
    )
    expect(changed.map((c) => c.key.parts)).toEqual([['2']])
  })

  it('skips ignored columns entirely', () => {
    const { summary } = diff('numeric', profile({ columns: ['id'] }, { ignoredColumns: ['stock', 'price'] }))
    expect(summary.counts.changed).toBe(0)
  })

  it('applies case-insensitivity only to the listed columns', () => {
    const p = profile({ columns: ['id'] }, { caseInsensitive: ['name'] })
    expect(diff('schema-change', p).summary.counts.changed).toBe(0)
    expect(diff('schema-change', profile({ columns: ['id'] })).summary.changesByColumn).toEqual({ name: 1 })
  })

  it('does not let key normalisation hide a value change in the key column', () => {
    const oldFile = { headers: ['sku', 'qty'], rows: [{ sku: 'abc', qty: '1' }], delimiter: ',' as const }
    const newFile = { headers: ['sku', 'qty'], rows: [{ sku: 'ABC', qty: '1' }], delimiter: ',' as const }
    const { summary } = diffFiles(oldFile, newFile, profile({ columns: ['sku'], caseInsensitive: true }))
    expect(summary.changesByColumn).toEqual({ sku: 1 })
  })

  it('reports schema changes and compares only shared columns', () => {
    const { summary } = diff('schema-change', profile({ columns: ['id'] }))
    expect(summary.schema).toEqual({ added: ['email'], removed: ['legacy'], shared: ['id', 'name'] })
    expect(Object.keys(summary.changesByColumn)).toEqual(['name'])
  })

  it('compares records whose fields span lines', () => {
    const { changed } = diff('embedded-newline', profile({ columns: ['id'] }))
    expect(changed[0].changes).toEqual([{ column: 'note', before: 'line one\nline two', after: 'line one\nline 2' }])
  })

  it('counts ambiguous and empty keys outside added/removed', () => {
    const { summary } = diff('composite-empty', profile({ columns: ['warehouse', 'sku'] }))
    expect(summary.counts).toEqual({ added: 0, removed: 0, changed: 1, unchanged: 1, ambiguous: 0, emptyKey: 2 })
    expect(diff('dup-in-new', profile({ columns: ['id'] })).summary.counts.ambiguous).toBe(1)
  })

  it('sorts per-column counts in the summary sentence, largest first', () => {
    const oldFile = { headers: ['id', 'price', 'stock'], rows: [{ id: '1', price: '1', stock: '1' }, { id: '2', price: '1', stock: '1' }], delimiter: ',' as const }
    const newFile = { headers: ['id', 'price', 'stock'], rows: [{ id: '1', price: '1', stock: '2' }, { id: '2', price: '2', stock: '2' }], delimiter: ',' as const }
    const { summary } = diffFiles(oldFile, newFile, profile({ columns: ['id'] }))
    expect(formatSummary(summary)).toBe('0 added, 0 removed, 2 changed (stock: 2, price: 1).')
  })

  it('rejects key columns missing from either file', () => {
    expect(() => diff('schema-change', profile({ columns: ['email'] }))).toThrow(RulesError)
    expect(() => diff('schema-change', profile({ columns: [] }))).toThrow('Choose at least one key column')
  })

  it('rejects an invalid tolerance', () => {
    const p = profile({ columns: ['id'] }, { numeric: { price: { tolerance: '-1', stripThousandsSeparator: false } } })
    expect(() => diff('tolerance', p)).toThrow(RulesError)
  })

  it('records the rules used', () => {
    const p = profile({ columns: ['id'] })
    expect(diff('reordered', p).summary.rulesUsed).toEqual(p)
  })
})
