import { formatSummary } from '../engine/diff'
import type { CompareResult } from '../worker/protocol'
import { KeyProblemsList } from './KeyProblemsList'

export function SummaryView({ result }: { result: CompareResult }) {
  const { summary } = result
  const { counts } = summary
  return (
    <section className="panel">
      <h2>Result</h2>
      <p className="headline">{formatSummary(summary)}</p>
      <p className="muted">
        {counts.unchanged} unchanged · {counts.ambiguous} ambiguous keys · {counts.emptyKey} empty keys
      </p>
      {(summary.schema.added.length > 0 || summary.schema.removed.length > 0) && (
        <p className="muted">
          Only shared columns were compared.
          {summary.schema.added.length > 0 && ` New file only: ${summary.schema.added.join(', ')}.`}
          {summary.schema.removed.length > 0 && ` Old file only: ${summary.schema.removed.join(', ')}.`}
        </p>
      )}
      <KeyProblemsList problems={result} ambiguousCount={counts.ambiguous} emptyKeyCount={counts.emptyKey} />
      {summary.warningCount > 0 && (
        <div className="warning">
          <h4>
            {summary.warningCount} numeric-validation warning{summary.warningCount === 1 ? '' : 's'}
          </h4>
          <ul>
            {summary.warnings.map((w, i) => (
              <li key={i}>
                {w.side} record {w.recordNumber}, {w.column}: {w.message}
              </li>
            ))}
          </ul>
          {summary.warningCount > summary.warnings.length && <p>Showing the first {summary.warnings.length}.</p>}
        </div>
      )}
      <details>
        <summary>Rules used</summary>
        <pre>{JSON.stringify(summary.rulesUsed, null, 2)}</pre>
      </details>
    </section>
  )
}
