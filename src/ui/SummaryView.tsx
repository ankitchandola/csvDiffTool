import { formatSummary } from '../engine/diff'
import type { CompareResult } from '../worker/protocol'
import { count } from './format'

export function SummaryView({ result }: { result: CompareResult }) {
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
      <details>
        <summary>Rules used</summary>
        <pre>{JSON.stringify(summary.rulesUsed, null, 2)}</pre>
      </details>
    </section>
  )
}
