import { Download, HardDrive, Upload } from 'lucide-react'
import { count } from '../format'
import { atRisk, backupText, storageText } from './save-status'
import type { SavedRef } from './session-store'
import type { StorageState } from './save-status'

export function SessionBar({
  revision,
  decisions,
  storage,
  backup,
  autosave,
  storageAvailable,
  stored,
  ownId,
  conflict,
  canExport,
  message,
  onExport,
  onImport,
  onAutosave,
  onResume,
  onDelete,
}: {
  revision: number
  decisions: number
  storage: StorageState
  backup: number | null
  autosave: boolean
  storageAvailable: boolean
  // What browser storage holds, if anything.
  stored: SavedRef | null
  ownId: string
  // A newer revision of this session is saved than this page has seen.
  conflict: boolean
  canExport: boolean
  message: { kind: 'error' | 'info'; text: string } | null
  onExport: () => void
  onImport: (file: File) => void
  onAutosave: (on: boolean) => void
  onResume: () => void
  onDelete: () => void
}) {
  const otherSaved = stored !== null && stored.id !== ownId
  const newerSaved = stored !== null && stored.id === ownId && conflict
  return (
    <section className="session-bar" aria-label="Session">
      <p className="save-status" role="status">
        <HardDrive size={14} aria-hidden="true" /> Revision {count(revision)} · {count(decisions)} decision{decisions === 1 ? '' : 's'} ·{' '}
        {storageText(storage, revision)} · {backupText(backup, revision)}
      </p>
      {decisions > 0 && atRisk(storage, backup, revision) && (
        <p className="warning">These decisions are only in this page. Export a backup or save in this browser; reloading the page loses them.</p>
      )}
      <div className="session-actions">
        <button type="button" disabled={!canExport} onClick={onExport}>
          <Download size={15} aria-hidden="true" /> Export session backup
        </button>
        <label className="secondary-file">
          <Upload size={15} aria-hidden="true" /> Import session
          <input
            type="file"
            accept=".json,application/json"
            aria-label="Import session file"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) onImport(file)
            }}
          />
        </label>
        {storageAvailable && (
          <label className="choice">
            <input type="checkbox" checked={autosave} onChange={(e) => onAutosave(e.target.checked)} /> Save this session in this browser
          </label>
        )}
        {storageAvailable && stored !== null && (
          <button type="button" className="secondary" onClick={onDelete}>
            Delete the session saved in this browser
          </button>
        )}
      </div>
      {storageAvailable && (
        <p className="note">
          Saving keeps transaction details from both files in this browser's storage, unencrypted, until you delete them. It is not a backup:
          clearing site data removes it.
        </p>
      )}
      {otherSaved && (
        <p className="note">
          This browser holds a saved session (revision {count(stored.revision)}).{' '}
          <button type="button" className="secondary" onClick={onResume}>
            Resume it
          </button>
        </p>
      )}
      {newerSaved && (
        <p className="note">
          This browser holds a newer revision of this session (revision {count(stored.revision)}). Resuming replaces this page's session
          with it; export a backup first to keep this page's decisions.{' '}
          <button type="button" className="secondary" onClick={onResume}>
            Resume the saved session
          </button>
        </p>
      )}
      {message && (
        <p className={message.kind === 'error' ? 'error' : 'note'} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
    </section>
  )
}
