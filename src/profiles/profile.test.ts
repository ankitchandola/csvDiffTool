import { describe, expect, it } from 'vitest'
import { diffFiles } from '../engine/diff'
import { parsedFixture } from '../engine/fixtures.test-helper'
import type { CompareProfile } from '../engine/types'
import {
  exportProfile,
  importProfile,
  missingColumns,
  PROFILE_FORMAT,
  ProfileError,
  profileFileName,
  readProfile,
  sameRules,
} from './profile'
import { createProfileStore } from './store'

const PRODUCTS: CompareProfile = {
  name: 'Daily products',
  parse: { delimiter: 'auto', trimHeaders: true },
  key: { columns: ['id'], trim: true, caseInsensitive: false },
  value: {
    ignoredColumns: ['legacy'],
    trim: false,
    caseInsensitive: ['name'],
    numeric: {
      price: { tolerance: '0.01', stripThousandsSeparator: false },
      stock: { tolerance: '0', stripThousandsSeparator: true },
    },
  },
}

function memoryStorage() {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data }
}

describe('profile round trip', () => {
  it('exports and imports to an identical profile', () => {
    expect(importProfile(exportProfile(PRODUCTS))).toEqual(PRODUCTS)
  })

  it('reproduces the same comparison when an exported profile is applied', () => {
    const oldFile = parsedFixture('numeric', 'old')
    const newFile = parsedFixture('numeric', 'new')
    const original = diffFiles(oldFile, newFile, PRODUCTS)
    const reapplied = diffFiles(oldFile, newFile, importProfile(exportProfile(PRODUCTS)))
    expect(reapplied).toEqual(original)
  })

  it('reproduces the same comparison from a profile saved, reloaded and applied', () => {
    const storage = memoryStorage()
    createProfileStore(storage).save(PRODUCTS)
    const [saved] = createProfileStore(storage).list()
    const oldFile = parsedFixture('tolerance', 'old')
    const newFile = parsedFixture('tolerance', 'new')
    expect(diffFiles(oldFile, newFile, saved)).toEqual(diffFiles(oldFile, newFile, PRODUCTS))
  })

  it('records the applied profile as the rules used', () => {
    const imported = importProfile(exportProfile(PRODUCTS))
    const { summary } = diffFiles(parsedFixture('numeric', 'old'), parsedFixture('numeric', 'new'), imported)
    expect(summary.rulesUsed).toEqual(PRODUCTS)
  })

  it('keeps a numeric rule for a column named __proto__', () => {
    const profile = {
      ...PRODUCTS,
      value: { ...PRODUCTS.value, numeric: Object.fromEntries([['__proto__', { tolerance: '1', stripThousandsSeparator: false }]]) },
    }
    const imported = importProfile(exportProfile(profile))
    expect(Object.hasOwn(imported.value.numeric, '__proto__')).toBe(true)
    expect(Object.keys(imported.value.numeric)).toEqual(['__proto__'])
  })
})

describe('importProfile validation', () => {
  function withProfile(patch: (p: Record<string, unknown>) => void): string {
    const file = JSON.parse(exportProfile(PRODUCTS))
    patch(file.profile)
    return JSON.stringify(file)
  }

  it.each([
    ['not JSON', '{', 'not valid JSON'],
    ['another format', JSON.stringify({ format: 'other', version: 1 }), 'not a CSV Diff profile'],
    ['a newer version', JSON.stringify({ format: PROFILE_FORMAT, version: 2, profile: {} }), 'newer version'],
  ])('rejects %s', (_, text, message) => {
    expect(() => importProfile(text)).toThrow(message)
  })

  it.each<[string, (p: Record<string, unknown>) => void, string]>([
    ['an empty name', (p) => (p.name = '  '), 'profile.name'],
    ['no key columns', (p) => ((p.key as Record<string, unknown>).columns = []), 'at least one column'],
    ['a repeated key column', (p) => ((p.key as Record<string, unknown>).columns = ['id', 'id']), 'more than once'],
    ['an unknown delimiter', (p) => ((p.parse as Record<string, unknown>).delimiter = '|'), 'parse.delimiter'],
    ['a misspelled field', (p) => ((p.value as Record<string, unknown>).ignoreColumns = []), 'unknown field: ignoreColumns'],
    [
      'a numeric tolerance',
      (p) => (((p.value as Record<string, Record<string, Record<string, unknown>>>).numeric.price.tolerance = 0.01)),
      'written as text',
    ],
    [
      'a negative tolerance',
      (p) => (((p.value as Record<string, Record<string, Record<string, unknown>>>).numeric.price.tolerance = '-1')),
      'non-negative',
    ],
    ['a string flag', (p) => ((p.key as Record<string, unknown>).trim = 'yes'), 'key.trim'],
  ])('rejects %s', (_, patch, message) => {
    expect(() => importProfile(withProfile(patch))).toThrow(message)
  })

  it('throws ProfileError so callers can show the message', () => {
    expect(() => readProfile(null)).toThrow(ProfileError)
  })

  it('trims the name', () => {
    expect(importProfile(withProfile((p) => (p.name = '  Daily  '))).name).toBe('Daily')
  })
})

describe('missingColumns', () => {
  it('separates missing key columns from missing rule columns', () => {
    expect(missingColumns(PRODUCTS, ['id', 'name', 'price'])).toEqual({ key: [], rules: ['legacy', 'stock'] })
    expect(missingColumns(PRODUCTS, ['name', 'price', 'stock', 'legacy'])).toEqual({ key: ['id'], rules: [] })
  })
})

describe('sameRules', () => {
  it('ignores the name and notices any rule change', () => {
    expect(sameRules(PRODUCTS, { ...PRODUCTS, name: 'Other' })).toBe(true)
    expect(sameRules(PRODUCTS, { ...PRODUCTS, key: { ...PRODUCTS.key, trim: false } })).toBe(false)
  })
})

describe('profileFileName', () => {
  it('builds a safe file name', () => {
    expect(profileFileName('Daily products / EU')).toBe('daily-products-eu.csv-diff-profile.json')
    expect(profileFileName('***')).toBe('profile.csv-diff-profile.json')
  })
})
