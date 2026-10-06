import { useState } from 'react'
import { ArrowDownToLine, FileJson, TriangleAlert } from 'lucide-react'
import type { CompareResult, ExportFormat } from '../worker/protocol'
import { count } from './format'

export function SummaryView({
  result,
  exporting,
  exportError,
  onExport,
}: {
  result: CompareResult
  exporting: boolean
  exportError: string | null
  onExport: (format: ExportFormat, escapeFormulae: boolean) => void
}) {
  const [escapeFormulae, setEscapeFormulae] = useState(true)
  const { summary } = result
  const { counts } = summary
  const metrics = [
    { label: 'Added', value: counts.added, kind: 'added' },
    { label: 'Removed', value: counts.removed, kind: 'removed' },
    { label: 'Changed', value: counts.changed, kind: 'changed' },
    { label: 'Unchanged', value: counts.unchanged, kind: 'unchanged' },
  ]
  return (
    <section className="results-summary" aria-label="Summary and export">
      <div className="results-toolbar">
        <div className="metric-grid">
          {metrics.map(({ label, value, kind }) => (
            <div className={`metric ${kind}`} key={kind}>
              <strong>{count(value)}</strong>
              <span className="metric-label">{label}</span>
            </div>
          ))}
        </div>
        <div className="export-actions">
          <button type="button" className="primary" disabled={exporting} onClick={() => onExport('csv', escapeFormulae)}>
            <ArrowDownToLine size={16} aria-hidden="true" /> Changes CSV
          </button>
          <button type="button" disabled={exporting} onClick={() => onExport('json', escapeFormulae)}>
            <FileJson size={16} aria-hidden="true" /> Full JSON
          </button>
        </div>
      </div>
      {(counts.ambiguous > 0 || counts.emptyKey > 0 || summary.warningCount > 0) && (
        <div className="warning result-warning" role="status">
          <TriangleAlert size={19} aria-hidden="true" />
          <div>
            <p>
              {count(counts.ambiguous)} ambiguous keys and {count(counts.emptyKey)} empty-key records were excluded;{' '}
              {count(summary.warningCount)} numeric warnings. Review the Problems tab for details.
            </p>
          </div>
        </div>
      )}
      {(summary.schema.added.length > 0 || summary.schema.removed.length > 0) && (
        <p className="note schema-note">
          Only shared columns were compared.
          {summary.schema.added.length > 0 && ` New file only: ${summary.schema.added.join(', ')}.`}
          {summary.schema.removed.length > 0 && ` Old file only: ${summary.schema.removed.join(', ')}.`}
        </p>
      )}
      <details className="export-details">
        <summary>
          Export options &amp; comparison details{' '}
          <span className="muted">Formula protection {escapeFormulae ? 'on' : 'off'}</span>
        </summary>
        <p className="note">Exports include the full comparison, regardless of the table filter.</p>
        <label className="row">
          <input type="checkbox" checked={escapeFormulae} onChange={(e) => setEscapeFormulae(e.target.checked)} />{' '}
          Protect the CSV against spreadsheet formulas
        </label>
        <p className={escapeFormulae ? 'note' : 'warning'}>
          {escapeFormulae
            ? 'CSV cells starting with =, +, -, @, tab or carriage return gain a leading apostrophe, except plain signed numbers such as -12. Protection does not cover every spreadsheet interpretation. Comparison values and JSON remain unchanged.'
            : 'CSV values are written exactly as read. Formula-like values may run when opened in a spreadsheet.'}
        </p>
        <p className="note">
          The CSV contains one row per field: change_type, key, column, before, after. Added and removed records include
          every field. Composite keys use a JSON array in one cell. Problems and unchanged records are not included in
          CSV.
        </p>
        <p className="note">
          The JSON report includes rules, changes, ambiguous keys, empty-key records, and numeric warnings. Spreadsheet
          imports can remove leading zeros from CSV values; JSON preserves the original strings.
        </p>
        <details className="audit-details">
          <summary>Rules used for this comparison</summary>
          <pre>{JSON.stringify(summary.rulesUsed, null, 2)}</pre>
        </details>
      </details>
      {exportError && (
        <p className="error" role="alert">
          {exportError}
        </p>
      )}
    </section>
  )
}
