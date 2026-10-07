import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT, type SessionFile } from '../../reconciliation/session'
import { DEFAULT_MATCHING, type SideMapping } from '../../reconciliation/types'
import { memorySessionStore, StorageConflictError } from './session-store'

const mapping: SideMapping = {
  delimiter: ',',
  layout: { headerRecord: 1, skipTrailing: 0 },
  date: { column: 'date', format: 'YYYY-MM-DD', kind: 'posting' },
  amount: { kind: 'signed', column: 'amount', positiveIs: 'in' },
  amountFormat: { grouped: false, trailingMinus: false, parentheses: false },
  reference: null,
  description: null,
}
const FP = 'd'.repeat(64)

function session(id: string, revision: number): SessionFile {
  return {
    format: SESSION_FORMAT,
    version: 1,
    id,
    savedAt: '2026-10-07T10:00:00.000Z',
    revision,
    context: { account: '', currency: 'INR', minorUnits: 2 },
    mappings: { bank: mapping, books: mapping },
    rules: DEFAULT_MATCHING,
    sources: { bank: { fileName: 'b.csv', fingerprint: FP, sheet: null, recordCount: 1 }, books: { fileName: 'l.csv', fingerprint: FP, sheet: null, recordCount: 1 } },
    events: [],
    snapshots: [],
  }
}

describe('session store', () => {
  it('saves and loads the session through its validated text form', async () => {
    const store = memorySessionStore()
    await store.save(session('a', 1), null)
    expect(await store.peek()).toEqual({ id: 'a', revision: 1 })
    expect(await store.load()).toEqual(session('a', 1))
  })

  it('refuses to overwrite a different session', async () => {
    const store = memorySessionStore()
    await store.save(session('a', 1), null)
    await expect(store.save(session('b', 1), null)).rejects.toThrow(StorageConflictError)
  })

  it('refuses a write from a tab that has not seen a later revision', async () => {
    const store = memorySessionStore()
    await store.save(session('a', 1), null)
    await store.save(session('a', 5), { id: 'a', revision: 1 })
    await expect(store.save(session('a', 2), { id: 'a', revision: 1 })).rejects.toThrow('A newer revision is saved in this browser (revision 5)')
    await store.save(session('a', 6), { id: 'a', revision: 5 })
    expect((await store.peek())?.revision).toBe(6)
  })

  it('uses source-neutral wording when an imported backup has not seen the saved revision', async () => {
    const store = memorySessionStore()
    await store.save(session('a', 5), null)
    await expect(store.save(session('a', 2), null)).rejects.toThrow(
      'A newer revision is saved in this browser (revision 5). Resume the saved session before saving here.',
    )
    expect((await store.peek())?.revision).toBe(5)
  })
})
