import { exportSession, importSession, type SessionFile } from '../../reconciliation/session'

export class StorageConflictError extends Error {}

export interface SavedRef {
  id: string
  revision: number
}

// One session per browser. Writes are refused when browser storage holds a different
// session, or this session at a later revision (another tab moved it on), so a tab
// never overwrites decisions it hasn't seen.
export interface SessionStore {
  peek(): Promise<SavedRef | null>
  load(): Promise<SessionFile | null>
  // lastSaved: what this tab last wrote or loaded, or null if it hasn't.
  save(session: SessionFile, lastSaved: SavedRef | null): Promise<void>
  remove(): Promise<void>
}

interface Record_ {
  id: string
  revision: number
  text: string
}

export function checkWrite(stored: SavedRef | null, session: SessionFile, lastSaved: SavedRef | null): void {
  if (!stored) return
  if (stored.id !== session.id) {
    throw new StorageConflictError('This browser holds a different saved session. Delete it or export it before saving this one.')
  }
  if (lastSaved === null || stored.revision > lastSaved.revision) {
    throw new StorageConflictError(`A newer revision is saved in this browser (revision ${stored.revision}). Resume the saved session before saving here.`)
  }
}

// For tests and as the behaviour IndexedDB must match.
export function memorySessionStore(): SessionStore & { record: Record_ | null } {
  const store = {
    record: null as Record_ | null,
    async peek() {
      return store.record && { id: store.record.id, revision: store.record.revision }
    },
    async load() {
      return store.record && importSession(store.record.text)
    },
    async save(session: SessionFile, lastSaved: SavedRef | null) {
      checkWrite(store.record, session, lastSaved)
      store.record = { id: session.id, revision: session.revision, text: exportSession(session) }
    },
    async remove() {
      store.record = null
    },
  }
  return store
}

const DB = 'reconciliation'
const STORE = 'sessions'
const KEY = 'current'

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('Browser storage failed'))
  })
}

function open(): Promise<IDBDatabase> {
  const r = indexedDB.open(DB, 1)
  r.onupgradeneeded = () => r.result.createObjectStore(STORE)
  return request(r)
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('Browser storage write was aborted'))
    tx.onerror = () => reject(tx.error ?? new Error('Browser storage write failed'))
  })
}

// Null when this browser has no IndexedDB (or blocks it); the UI then offers backups only.
export function indexedDbSessionStore(): SessionStore | null {
  if (typeof indexedDB === 'undefined') return null
  async function read(): Promise<Record_ | null> {
    const db = await open()
    try {
      return ((await request(db.transaction(STORE).objectStore(STORE).get(KEY))) as Record_ | undefined) ?? null
    } finally {
      db.close()
    }
  }
  return {
    async peek() {
      const record = await read()
      return record && { id: record.id, revision: record.revision }
    },
    async load() {
      const record = await read()
      return record && importSession(record.text)
    },
    async save(session, lastSaved) {
      const db = await open()
      try {
        // Check and write in one transaction, so another tab can't write in between.
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        const stored = ((await request(store.get(KEY))) as Record_ | undefined) ?? null
        try {
          checkWrite(stored, session, lastSaved)
        } catch (error) {
          tx.abort()
          throw error
        }
        store.put({ id: session.id, revision: session.revision, text: exportSession(session) } satisfies Record_, KEY)
        await done(tx)
      } finally {
        db.close()
      }
    },
    async remove() {
      const db = await open()
      try {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).delete(KEY)
        await done(tx)
      } finally {
        db.close()
      }
    },
  }
}
