import { formatSummary } from '../engine/diff'
import type { CompareResult } from '../worker/protocol'
import { count, RECORD_NUMBER_NOTE } from './format'
import { ShowingNote } from './ShowingNote'
import { KeyProblemsList } from './KeyProblemsList'

export function SummaryView({ result }: { result: CompareResult }) {
  const { summary, warnings } = result
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
      <KeyProblemsList problems={result} />
      {warnings.total > 0 && (
        <div className="warning">
          <h4>
            {count(warnings.total)} numeric-validation warning{warnings.total === 1 ? '' : 's'}
          </h4>
          <ul>
            {warnings.items.map((w, i) => (
              <li key={i}>
                {w.side} data record {w.recordNumber}, {w.column}: {w.message}
              </li>
            ))}
          </ul>
          <ShowingNote shown={warnings.items.length} total={warnings.total} />
          <p className="note">{RECORD_NUMBER_NOTE}</p>
        </div>
      )}
      <details>
        <summary>Rules used</summary>
        <pre>{JSON.stringify(summary.rulesUsed, null, 2)}</pre>
      </details>
    </section>
  )
}
