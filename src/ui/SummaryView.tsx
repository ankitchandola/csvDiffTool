import { useState } from 'react'
import { formatSummary } from '../engine/diff'
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
  return (
    <section className="panel">
      <h2>Result</h2>
      <p className="headline">{formatSummary(summary)}</p>
      <p className="muted">
        {count(counts.unchanged)} unchanged · {count(counts.ambiguous)} ambiguous keys · {count(counts.emptyKey)} empty keys
      </p>
      {(summary.schema.added.length > 0 || summary.schema.removed.length > 0) && (
        <p className="muted">
          Only shared columns were compared.
          {summary.schema.added.length > 0 && ` New file only: ${summary.schema.added.join(', ')}.`}
          {summary.schema.removed.length > 0 && ` Old file only: ${summary.schema.removed.join(', ')}.`}
        </p>
      )}
      {(counts.ambiguous > 0 || counts.emptyKey > 0 || summary.warningCount > 0) && (
        <p className="warning">
          {count(counts.ambiguous)} ambiguous keys and {count(counts.emptyKey)} empty keys were left out of the
          comparison; {count(summary.warningCount)} numeric warnings. See the Problems tab.
        </p>
      )}
      <div className="row">
        <button type="button" disabled={exporting} onClick={() => onExport('csv', escapeFormulae)}>
          Download changes (CSV)
        </button>
        <button type="button" className="secondary" disabled={exporting} onClick={() => onExport('json', escapeFormulae)}>
          Download full report (JSON)
        </button>
      </div>
      <label className="row">
        <input type="checkbox" checked={escapeFormulae} onChange={(e) => setEscapeFormulae(e.target.checked)} />
        Protect the CSV against spreadsheet formulas
      </label>
      <p className="note">
        {escapeFormulae
          ? "Values starting with =, +, -, @, a tab or a line break (other than plain numbers such as -12) gain a leading ' in the CSV so a spreadsheet shows them as text instead of running them. The comparison and the JSON report keep the original values."
          : 'CSV values are written exactly as read. A value starting with = may run as a formula when the file is opened in a spreadsheet.'}
      </p>
      <p className="note">
        The CSV has one line per changed field (change_type, key, column, before, after); a composite key is written as a
        JSON array. The JSON report starts with the rules used and includes ambiguous keys, empty keys and warnings.
      </p>
      {exportError && <p className="error">{exportError}</p>}
      <details>
        <summary>Rules used</summary>
        <pre>{JSON.stringify(summary.rulesUsed, null, 2)}</pre>
      </details>
    </section>
  )
}
