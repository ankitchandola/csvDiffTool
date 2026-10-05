import type { CompareProfile } from '../engine/types'
import { ProfileError, readProfileFile, toProfileFile } from './profile'

export const STORAGE_KEY = 'csv-diff:profiles'

const NOT_PERSISTENT = "Profiles can't be saved in this browser, so they last only for this session. Use Export to keep one."

export interface ProfileStore {
  list(): CompareProfile[]
  save(profile: CompareProfile): CompareProfile[]
  remove(name: string): CompareProfile[]
  // Set when saved profiles can't be kept, or some stored ones couldn't be read.
  problem: string | null
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function byName(a: CompareProfile, b: CompareProfile): number {
  return a.name.localeCompare(b.name)
}

// Profiles live in this browser's storage; export/import JSON is the way to move them.
// Storage can be missing or blocked (private windows, disabled site data), so every
// access is guarded and the store falls back to memory for the session.
export function createProfileStore(storage: StorageLike | null): ProfileStore {
  let profiles: CompareProfile[] = []
  // Written back untouched, so a profile from a newer version isn't lost when this one saves.
  const unreadable: unknown[] = []
  let persistent = storage !== null
  let problem: string | null = null

  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (raw) {
      const stored: unknown = JSON.parse(raw)
      if (!Array.isArray(stored)) throw new ProfileError('Saved profiles are not a list')
      for (const entry of stored) {
        try {
          profiles.push(readProfileFile(entry))
        } catch (error) {
          if (!(error instanceof ProfileError)) throw error
          unreadable.push(entry)
        }
      }
      const n = unreadable.length
      if (n > 0) problem = `${n} saved profile${n === 1 ? '' : 's'} could not be read and ${n === 1 ? 'is' : 'are'} hidden.`
    }
  } catch {
    persistent = false
  }
  if (!persistent) problem = NOT_PERSISTENT
  profiles.sort(byName)

  function write() {
    if (!persistent || !storage) return
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify([...profiles.map(toProfileFile), ...unreadable]))
    } catch {
      persistent = false
      store.problem = NOT_PERSISTENT
    }
  }

  const store: ProfileStore = {
    problem,
    list: () => [...profiles],
    save(profile) {
      profiles = [...profiles.filter((p) => p.name !== profile.name), profile].sort(byName)
      write()
      return [...profiles]
    },
    remove(name) {
      profiles = profiles.filter((p) => p.name !== name)
      write()
      return [...profiles]
    },
  }
  return store
}

export function browserStorage(): StorageLike | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
