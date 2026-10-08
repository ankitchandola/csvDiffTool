import { useEffect, useRef, useState } from 'react'
import { type DecisionEvent, eventKeys, type TxnKey } from '../../reconciliation/decisions'
import { type AccountingSetup, exportSession, type OpeningFile, SESSION_FORMAT, SESSION_VERSION, type SessionFile, type SourceDescriptor, type TransactionSnapshot } from '../../reconciliation/session'
import type { MatchingRules, ReconSide, SessionContext, SideMapping } from '../../reconciliation/types'
import type { StorageState } from './save-status'
import { createLatestWriter } from './latest-writer'
import { type SavedRef, StorageConflictError, type SessionStore } from './session-store'

// Everything a session file holds besides its history: complete only once both files
// are read and both mappings are valid.
export interface SessionConfig {
  context: SessionContext
  mappings: Record<ReconSide, SideMapping>
  rules: MatchingRules
  sources: Record<ReconSide, SourceDescriptor>
  accounting: AccountingSetup
  opening: OpeningFile[]
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function newId(): string {
  return crypto.randomUUID()
}

// The decision history lives here, on the page, not in the worker: cancelling or losing
// the worker never loses it, and the worker is sent it again after every run.
export function useSession(store: SessionStore | null, config: SessionConfig | null) {
  const [id, setId] = useState(newId)
  const [revision, setRevision] = useState(0)
  const [events, setEvents] = useState<DecisionEvent[]>([])
  const eventsRef = useRef<DecisionEvent[]>([])
  const [snapshots, setSnapshots] = useState<Map<TxnKey, TransactionSnapshot>>(() => new Map())
  const [autosave, setAutosave] = useState(false)
  const [storage, setStorage] = useState<StorageState>({ kind: 'off' })
  // Browser storage holds a revision of this session that this page has not seen.
  const [conflict, setConflict] = useState(false)
  const [backup, setBackup] = useState<number | null>(null)
  const [stored, setStored] = useState<SavedRef | null>(null)
  // The files a loaded session was made from, until they are loaded again.
  const [expected, setExpected] = useState<Record<ReconSide, SourceDescriptor> | null>(null)
  const lastSaved = useRef<SavedRef | null>(null)

  const configKey = config ? JSON.stringify(config) : null
  const previousConfig = useRef(configKey)
  useEffect(() => {
    if (previousConfig.current === configKey) return
    const hadConfig = previousConfig.current !== null
    previousConfig.current = configKey
    // A changed file, mapping or rule is a new revision; reaching a complete setup is not.
    if (hadConfig && configKey !== null) setRevision((r) => r + 1)
  }, [configKey])

  useEffect(() => {
    let live = true
    store
      ?.peek()
      .then((ref) => {
        if (live) setStored(ref)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [store])

  function build(from: SessionConfig): SessionFile {
    const referenced = new Set(eventsRef.current.flatMap(eventKeys))
    return {
      format: SESSION_FORMAT,
      version: SESSION_VERSION,
      id,
      savedAt: new Date().toISOString(),
      revision,
      ...from,
      events: eventsRef.current,
      snapshots: [...snapshots.values()].filter((s) => referenced.has(s.key)),
    }
  }

  // Saves run one at a time; while one runs, later revisions collapse into a single save of
  // the newest, so a large session isn't rewritten once per decision.
  const writer = useRef(
    createLatestWriter(async ({ target, session }: { target: SessionStore; session: SessionFile }) => {
      setStorage({ kind: 'saving' })
      try {
        await target.save(session, lastSaved.current)
        lastSaved.current = { id: session.id, revision: session.revision }
        setStored(lastSaved.current)
        setStorage({ kind: 'saved', revision: session.revision })
        setConflict(false)
      } catch (error) {
        setConflict(error instanceof StorageConflictError)
        setStorage({ kind: 'error', message: message(error), lastSaved: lastSaved.current?.revision ?? null })
      }
    }),
  )
  useEffect(() => {
    if (!autosave || !store || !config) return
    void writer.current.request({ target: store, session: build(config) })
    // build reads the latest history through refs and state captured at this revision.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [autosave, store, revision, configKey])

  // One reviewer action, which may be several events (a set confirm), is one revision.
  function record(events: DecisionEvent[], eventSnapshots: TransactionSnapshot[]) {
    eventsRef.current = [...eventsRef.current, ...events]
    setEvents(eventsRef.current)
    setSnapshots((prev) => {
      const next = new Map(prev)
      for (const s of eventSnapshots) if (!next.has(s.key)) next.set(s.key, s)
      return next
    })
    setRevision((r) => r + 1)
  }

  function load(session: SessionFile, fromBrowser: boolean) {
    eventsRef.current = session.events
    setId(session.id)
    setEvents(session.events)
    setSnapshots(new Map(session.snapshots.map((s) => [s.key, s])))
    setRevision(session.revision)
    setExpected(session.sources)
    setBackup(null)
    previousConfig.current = null
    setConflict(false)
    if (fromBrowser) {
      lastSaved.current = { id: session.id, revision: session.revision }
      setStorage({ kind: 'saved', revision: session.revision })
      setAutosave(true)
    } else {
      lastSaved.current = null
      setStorage({ kind: 'off' })
      setAutosave(false)
    }
  }

  return {
    id,
    revision,
    events,
    eventsRef,
    snapshots,
    autosave,
    storage,
    conflict,
    backup,
    stored,
    expected,
    available: store !== null,
    record,
    clearExpected: () => setExpected(null),
    exportBackup(from: SessionConfig): { text: string; revision: number } {
      const text = exportSession(build(from))
      setBackup(revision)
      return { text, revision }
    },
    load,
    readSaved: async (): Promise<SessionFile | null> => (store ? store.load() : null),
    setAutosave(on: boolean) {
      setAutosave(on)
      if (!on && storage.kind !== 'saved') setStorage({ kind: 'off' })
    },
    async deleteSaved() {
      if (!store) return
      await store.remove()
      lastSaved.current = null
      setStored(null)
      setAutosave(false)
      setStorage({ kind: 'off' })
    },
  }
}
