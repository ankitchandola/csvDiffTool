import { useState } from 'react'
import type { CompareProfile } from '../engine/types'
import { Select } from './Select'

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
    <section className="profile-content">
      <p className="note">Save a named set of parse, key, and value rules for your next comparison.</p>
      <div className="row">
        <Select
          label="Saved profiles"
          value={chosen ? selected : ''}
          onChange={setSelected}
          disabled={saved.length === 0}
          options={[
            { value: '', label: saved.length === 0 ? 'No saved profiles' : 'Choose a profile' },
            ...saved.map((profile) => ({ value: profile.name, label: profile.name })),
          ]}
        />
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
          Name{' '}
          <input
            type="text"
            value={name}
            placeholder="e.g. Daily product export"
            onChange={(e) => onNameChange(e.target.value)}
          />
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
      {message && (
        <p role="status" className={message.kind === 'error' ? 'error' : 'note'}>
          {message.text}
        </p>
      )}
      {storeProblem && <p className="warning">{storeProblem}</p>}
    </section>
  )
}
