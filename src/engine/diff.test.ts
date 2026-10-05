import { describe, expect, it } from 'vitest'
import { diffFiles, formatSummary } from './diff'
import { parsedFixture, profile } from './fixtures.test-helper'
import { parseCsv } from './parse'
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

  it('reports 0007 → 7 in a non-key column as a field change', () => {
    const { changed } = diff('leading-zeros', profile({ columns: ['sku'] }))
    expect(changed).toEqual([
      { key: { encoded: '["00123"]', parts: ['00123'] }, oldIndex: 0, newIndex: 0, changes: [{ column: 'code', before: '0007', after: '7' }] },
    ])
  })

  it('reports a key that changes from 0007 to 7 as a removal plus an addition', () => {
    const oldFile = { headers: ['sku', 'qty'], rows: [{ sku: '0007', qty: '1' }], delimiter: ',' as const }
    const newFile = { headers: ['sku', 'qty'], rows: [{ sku: '7', qty: '1' }], delimiter: ',' as const }
    const { summary, keys } = diffFiles(oldFile, newFile, profile({ columns: ['sku'] }))
    expect(summary.counts).toMatchObject({ added: 1, removed: 1, changed: 0, unchanged: 0 })
    expect(keys.removed).toEqual([0])
    expect(keys.added).toEqual([0])
  })

  it('treats numeric formatting differences as changes unless the column is numeric', () => {
    const plain = diff('numeric', profile({ columns: ['id'] }))
    expect(plain.summary.changesByColumn).toEqual({ price: 1, stock: 2 })
    expect(plain.summary.warningCount).toBe(0)
  })

  it('compares numeric columns as decimals and warns on unparseable values', () => {
    const { summary, changed, warnings } = diff(
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
    expect(summary.warningCount).toBe(2)
    expect(warnings).toEqual([
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

describe('headers that collide with Object.prototype names', () => {
  const rules = { delimiter: 'auto', trimHeaders: true } as const

  it('keeps their values and counts their changes', () => {
    const a = parseCsv('id,__proto__,constructor,toString\n1,x,a,p\n', rules)
    const b = parseCsv('id,__proto__,constructor,toString\n1,y,b,q\n', rules)
    if (!a.ok || !b.ok) throw new Error('parse failed')
    expect(a.file.rows[0].__proto__).toBe('x')
    const { summary } = diffFiles(a.file, b.file, profile({ columns: ['id'] }))
    expect(formatSummary(summary)).toBe('0 added, 0 removed, 1 changed (__proto__: 1, constructor: 1, toString: 1).')
  })

  it('survive the structured clone to the UI thread', () => {
    const a = parseCsv('__proto__,constructor\nx,a\n', rules)
    if (!a.ok) throw new Error('parse failed')
    const cloned = structuredClone(a.file.rows[0])
    expect(Object.hasOwn(cloned, '__proto__')).toBe(true)
    expect(Object.entries(cloned)).toEqual([
      ['__proto__', 'x'],
      ['constructor', 'a'],
    ])
  })

  it('accepts a numeric rule for a column named constructor', () => {
    const a = parseCsv('id,constructor\n1,1.0\n', rules)
    const b = parseCsv('id,constructor\n1,1.00\n', rules)
    if (!a.ok || !b.ok) throw new Error('parse failed')
    const numeric = Object.fromEntries([['constructor', { tolerance: '0', stripThousandsSeparator: false }]])
    expect(diffFiles(a.file, b.file, profile({ columns: ['id'] }, { numeric })).summary.counts.changed).toBe(0)
  })
})

describe('ignored columns', () => {
  it('skip their numeric rules, including an invalid tolerance', () => {
    const p = profile(
      { columns: ['id'] },
      { ignoredColumns: ['price'], numeric: { price: { tolerance: 'not a number', stripThousandsSeparator: false } } },
    )
    expect(diff('tolerance', p).summary.counts).toMatchObject({ changed: 0, unchanged: 2 })
  })
})
