import { describe, expect, it } from 'vitest'
import { parsedFixture } from './fixtures.test-helper'
import { classifyKeys, encodeKey } from './keys'
import type { KeyRules } from './types'

function classify(name: string, rules: Partial<KeyRules> & Pick<KeyRules, 'columns'>) {
  return classifyKeys(parsedFixture(name, 'old').rows, parsedFixture(name, 'new').rows, {
    trim: true,
    caseInsensitive: false,
    ...rules,
  })
}

describe('classifyKeys', () => {
  it('matches reordered records', () => {
    const result = classify('reordered', { columns: ['id'] })
    expect(result.matched).toHaveLength(3)
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
    expect(result.matched.find((m) => m.encoded === '["3"]')).toMatchObject({ oldIndex: 2, newIndex: 0 })
  })

  it('excludes a key that is once in old and twice in new from both sides', () => {
    const result = classify('dup-in-new', { columns: ['id'] })
    expect(result.ambiguous).toEqual([
      {
        encoded: '["1"]',
        old: [{ recordNumber: 1, parts: ['1'] }],
        new: [
          { recordNumber: 1, parts: ['1'] },
          { recordNumber: 2, parts: ['1'] },
        ],
      },
    ])
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
    expect(result.matched.map((m) => m.encoded)).toEqual(['["2"]'])
  })

  it('excludes a key that is twice in old and once in new from both sides', () => {
    const result = classify('dup-in-old', { columns: ['id'] })
    expect(result.ambiguous).toHaveLength(1)
    expect(result.ambiguous[0].old).toHaveLength(2)
    expect(result.ambiguous[0].new).toHaveLength(1)
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
  })

  it('reports a normalization collision with the original values', () => {
    const result = classify('collision', { columns: ['sku'], caseInsensitive: true })
    expect(result.ambiguous).toEqual([
      {
        encoded: '["abc"]',
        old: [{ recordNumber: 1, parts: ['ABC'] }],
        new: [
          { recordNumber: 1, parts: ['ABC'] },
          { recordNumber: 2, parts: [' abc '] },
        ],
      },
    ])
  })

  it('treats differently-cased keys as distinct when case-insensitive is off', () => {
    const result = classify('collision', { columns: ['sku'] })
    expect(result.ambiguous).toEqual([])
    expect(result.added).toEqual([1])
  })

  it('reports a composite key with an empty component instead of matching it', () => {
    const result = classify('composite-empty', { columns: ['warehouse', 'sku'] })
    expect(result.emptyKey).toEqual([
      { side: 'old', recordNumber: 2, parts: ['w1', ''] },
      { side: 'new', recordNumber: 2, parts: ['', '00999'] },
    ])
    expect(result.matched.map((m) => m.encoded)).toEqual(['["w1","00123"]', '["w2","00123"]'])
  })

  it('keeps leading zeros significant in keys', () => {
    const result = classify('leading-zeros', { columns: ['sku'] })
    expect(result.matched.map((m) => m.encoded)).toEqual(['["00123"]', '["123"]'])
  })

  it('finds added and removed records', () => {
    const oldRows = [{ id: '1' }, { id: '2' }]
    const newRows = [{ id: '2' }, { id: '3' }]
    const result = classifyKeys(oldRows, newRows, { columns: ['id'], trim: true, caseInsensitive: false })
    expect(result.removed).toEqual([0])
    expect(result.added).toEqual([1])
  })

  it('encodes composite keys without separator collisions', () => {
    expect(encodeKey(['a,b', 'c'])).not.toBe(encodeKey(['a', 'b,c']))
    expect(encodeKey(['a|b', 'c'])).not.toBe(encodeKey(['a', 'b|c']))
  })
})
