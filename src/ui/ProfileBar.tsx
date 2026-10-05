import { useState } from 'react'
import type { CompareProfile } from '../engine/types'

export type ProfileMessage = { kind: 'error' | 'info'; text: string }

export function ProfileBar({
  name,
  onNameChange,
  saved,
  modified,
  canSave,
  message,
  storeProblem,
  onSave,
  onApply,
  onDelete,
  onExport,
  onImport,
}: {
  name: string
  onNameChange: (name: string) => void
  saved: CompareProfile[]
  modified: boolean
  canSave: boolean
  message: ProfileMessage | null
  storeProblem: string | null
  onSave: () => void
  onApply: (profile: CompareProfile) => void
  onDelete: (name: string) => void
  onExport: () => void
  onImport: (file: File) => void
}) {
  const [selected, setSelected] = useState('')
  const chosen = saved.find((p) => p.name === selected) ?? null
  const exists = saved.some((p) => p.name === name.trim())

  return (
    <section className="panel">
      <h2>Profile</h2>
      <div className="row">
        <label>
          Saved{' '}
          <select value={chosen ? selected : ''} onChange={(e) => setSelected(e.target.value)}>
            <option value="">{saved.length === 0 ? 'No saved profiles' : 'Choose a profile'}</option>
            {saved.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={!chosen} onClick={() => chosen && onApply(chosen)}>
          Apply
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!chosen}
          onClick={() => {
            if (chosen && window.confirm(`Delete the profile "${chosen.name}" from this browser?`)) {
              onDelete(chosen.name)
              setSelected('')
            }
          }}
        >
          Delete
        </button>
        <label className="secondary-file">
          Import JSON
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) onImport(file)
              e.target.value = ''
            }}
          />
        </label>
      </div>
      <div className="row">
        <label>
          Name <input type="text" value={name} placeholder="e.g. Daily product export" onChange={(e) => onNameChange(e.target.value)} />
        </label>
        <button type="button" disabled={!canSave} onClick={onSave}>
          {exists ? 'Update saved profile' : 'Save profile'}
        </button>
        <button type="button" className="secondary" disabled={!canSave} onClick={onExport}>
          Export JSON
        </button>
        {modified && <span className="muted">Rules changed since “{name.trim()}” was saved.</span>}
      </div>
      {!canSave && <p className="note">Name the profile and choose at least one key column to save or export it.</p>}
      {message && <p className={message.kind === 'error' ? 'error' : 'note'}>{message.text}</p>}
      {storeProblem && <p className="warning">{storeProblem}</p>}
    </section>
  )
}
