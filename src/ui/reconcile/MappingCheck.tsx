import { RECON_SIDES, type ReconSide } from '../../reconciliation/types'
import type { NormalizeResult, SideSummary } from '../../worker/reconcile-protocol'
import { count, counted, formatValue } from '../format'
import { type Formats, locationText, SIDE_LABELS } from './location'

function OpeningCheck({ result }: { result: Extract<NormalizeResult, { ok: true }> }) {
  const { items, warnings, overlaps } = result.opening
  if (items.bank + items.books === 0) return null
  return (
    <div className={warnings.length > 0 ? 'warning' : 'note'}>
      <p>
        Opening items: {counted(items.bank, 'bank item')} and {counted(items.books, 'books item')} carried from earlier periods. They are
        matched against this period's transactions and not counted in its movement.
      </p>
      {warnings.length > 0 && (
        <ul>
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {overlaps.length > 0 && (
        <ul>
          {overlaps.map((o) => (
            <li key={o.lineage}>
              A carried {SIDE_LABELS[o.side].toLowerCase()} item may repeat {o.records.length === 1 ? 'record' : 'records'} {o.records.join(', ')} of this
              period's {SIDE_LABELS[o.side].toLowerCase()} file. If the export overlaps the previous period, its balances will not validate.
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function SideCheck({ side, summary, formats }: { side: ReconSide; summary: SideSummary; formats: Formats }) {
  return (
    <div className="side-check">
      <h3>{SIDE_LABELS[side]}</h3>
      <p className="key-status">
        {counted(summary.rows, 'record')}: {count(summary.valid)} valid ({count(summary.moneyIn)} money in, {count(summary.moneyOut)} money out) ·{' '}
        {count(summary.zero)} zero · {counted(summary.problemRows, 'record')} with problems
        {summary.batches > 0 && <> · {counted(summary.batches, 'batch', 'batches')} matched as totals</>}
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Date as written</th>
              <th>Amount as written</th>
              <th>Date</th>
              <th>Amount</th>
              <th>Direction</th>
            </tr>
          </thead>
          <tbody>
            {summary.sample.map((row) => (
              <tr key={row.recordNumber} className={row.problems.length > 0 ? 'problem' : ''}>
                <td>{locationText(row, formats)}</td>
                <td className="mono">{formatValue(row.original.date)}</td>
                <td className="mono">{row.original.amount.map(formatValue).join(' / ')}</td>
                {row.normalized ? (
                  <>
                    <td className="mono">{row.normalized.date}</td>
                    <td className="mono">{row.normalized.amount}</td>
                    <td>{row.normalized.direction === 'in' ? 'Money in' : 'Money out'}</td>
                  </>
                ) : (
                  <td colSpan={3}>{row.zero ? 'Zero amount: kept out of matching' : row.problems.join('; ')}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function MappingCheck({ result, formats }: { result: NormalizeResult; formats: Formats }) {
  if (!result.ok) {
    return (
      <ul className="error" role="alert">
        {result.issues.map((issue) => (
          <li key={`${issue.side}-${issue.message}`}>
            {issue.side ? `${SIDE_LABELS[issue.side]}: ` : ''}
            {issue.message}
          </li>
        ))}
      </ul>
    )
  }
  return (
    <section aria-label="Mapping check" className="mapping-check">
      <OpeningCheck result={result} />
      {RECON_SIDES.map((side) => (
        <SideCheck key={side} side={side} summary={result.sides[side]} formats={formats} />
      ))}
    </section>
  )
}
