import { describe, expect, it } from 'vitest'
import type { CompareProfile } from '../engine/types'
import { exportProfile } from './profile'
import { createProfileStore, STORAGE_KEY } from './store'

function profile(name: string, keyColumn = 'id'): CompareProfile {
  return {
    name,
    parse: { delimiter: 'auto', trimHeaders: true },
    key: { columns: [keyColumn], trim: true, caseInsensitive: false },
    value: { ignoredColumns: [], trim: false, caseInsensitive: [], numeric: {} },
  }
}

function memoryStorage(initial?: string) {
  const data = new Map<string, string>()
  if (initial !== undefined) data.set(STORAGE_KEY, initial)
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data }
}

describe('createProfileStore', () => {
  it('saves, lists by name and survives a reload', () => {
    const storage = memoryStorage()
    const store = createProfileStore(storage)
    store.save(profile('Vendors'))
    store.save(profile('Accounts'))
    expect(createProfileStore(storage).list().map((p) => p.name)).toEqual(['Accounts', 'Vendors'])
    expect(store.problem).toBeNull()
  })

  it('replaces a profile saved under the same name', () => {
    const store = createProfileStore(memoryStorage())
    store.save(profile('Vendors', 'id'))
    expect(store.save(profile('Vendors', 'vendor_no'))).toEqual([profile('Vendors', 'vendor_no')])
  })

  it('removes a profile', () => {
    const storage = memoryStorage()
    createProfileStore(storage).save(profile('Vendors'))
    expect(createProfileStore(storage).remove('Vendors')).toEqual([])
    expect(createProfileStore(storage).list()).toEqual([])
  })

  it('hides unreadable entries but keeps them when saving', () => {
    const newer = { format: 'csv-diff-profile', version: 9, profile: { name: 'From the future' } }
    const valid = JSON.parse(exportProfile(profile('Vendors')))
    const storage = memoryStorage(JSON.stringify([valid, newer]))
    const store = createProfileStore(storage)
    expect(store.list().map((p) => p.name)).toEqual(['Vendors'])
    expect(store.problem).toBe('1 saved profile could not be read and is hidden.')

    store.save(profile('Accounts'))
    expect(JSON.parse(storage.data.get(STORAGE_KEY) ?? '[]')).toContainEqual(newer)
  })

  it('does not overwrite stored data it cannot parse', () => {
    const storage = memoryStorage('not json')
    const store = createProfileStore(storage)
    store.save(profile('Vendors'))
    expect(storage.data.get(STORAGE_KEY)).toBe('not json')
    expect(store.list().map((p) => p.name)).toEqual(['Vendors'])
    expect(store.problem).toMatch("can't be saved")
  })

  it('works in memory when storage is unavailable', () => {
    const store = createProfileStore(null)
    store.save(profile('Vendors'))
    expect(store.list()).toHaveLength(1)
    expect(store.problem).toMatch('only for this session')
  })

  it('falls back to memory when writing fails', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    const store = createProfileStore(storage)
    expect(store.save(profile('Vendors'))).toHaveLength(1)
    expect(store.problem).toMatch('only for this session')
  })
})
