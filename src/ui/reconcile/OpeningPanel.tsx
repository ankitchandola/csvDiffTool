import { Upload } from 'lucide-react'
import type { OpeningFile } from '../../reconciliation/session'
import type { OpeningFileInfo } from '../../worker/reconcile-protocol'
import { counted } from '../format'

// Outstanding items carried from earlier periods. They join matching as opening items on
// their original side and are never added to this period's movement.
export function OpeningPanel({
  files,
  info,
  errors,
  onAdd,
  onRemove,
}: {
  files: OpeningFile[]
  info: OpeningFileInfo[]
  errors: string[]
  onAdd: (files: File[]) => void
  onRemove: (name: string) => void
}) {
  return (
    <fieldset className="panel opening-panel">
      <legend>Opening items</legend>
      <p className="note">
        Import the outstanding items exported at the end of the previous period. They keep their original dates and are matched against this
        period's transactions; they are not counted again in this period's movement. Enter the period first.
      </p>
      {files.length > 0 && (
        <ul className="opening-files">
          {files.map((file) => {
            const details = info.find((i) => i.name === file.name)
            return (
              <li key={file.name}>
                <span>
                  <strong>{file.name}</strong>
                  {details &&
                    ` · ${details.period.start} to ${details.period.end} · ${counted(details.items, 'outstanding item')} · ${counted(details.cleared, 'cleared item')}`}
                </span>
                <button type="button" className="secondary" onClick={() => onRemove(file.name)}>
                  Remove
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <label className="secondary-file">
        <Upload size={15} aria-hidden="true" /> Import outstanding items
        <input
          type="file"
          accept=".json,application/json"
          multiple
          aria-label="Import outstanding items file"
          onChange={(e) => {
            const picked = [...(e.target.files ?? [])]
            e.target.value = ''
            if (picked.length > 0) onAdd(picked)
          }}
        />
      </label>
      {errors.length > 0 && (
        <ul className="error" role="alert">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </fieldset>
  )
}
