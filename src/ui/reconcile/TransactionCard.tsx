import type { TransactionView } from '../../worker/reconcile-protocol'
import { count, counted, formatValue } from '../format'
import { type Formats, locationText, originalAmount } from './location'

export function TransactionCard({ t, formats }: { t: TransactionView; formats: Formats }) {
  return (
    <div className="txn">
      <div className="txn-main">
        <span className="mono">{t.date}</span>
        <span className={`mono amount ${t.direction}`}>{t.amount}</span>
        <span className="direction">{t.direction === 'in' ? '↓ Money in' : '↑ Money out'}</span>
      </div>
      {(t.reference !== null || t.original.description) && (
        <div className="txn-context">
          {t.reference !== null && <span className="mono">Ref {t.reference}</span>}
          {t.original.description && (
            <span className="txn-description" title={t.original.description}>
              {t.original.description}
            </span>
          )}
        </div>
      )}
      {t.carried && (
        <div className="txn-carried">
          <span className="chip competing">Carried</span> from {t.carried.fileName}, period {t.carried.period.start} to {t.carried.period.end}
        </div>
      )}
      {t.group ? (
        <GroupMembers group={t.group} formats={formats} />
      ) : (
        <div className="txn-source muted">
          {locationText(t, formats)} · as written: {formatValue(t.original.date)}, {originalAmount(t.original)}
        </div>
      )}
    </div>
  )
}

function GroupMembers({ group, formats }: { group: NonNullable<TransactionView['group']>; formats: Formats }) {
  const hidden = group.size - group.members.length
  return (
    <details className="group-members">
      <summary>
        Show {counted(group.size, 'member')}
        <span className="muted">
          {' '}
          · {group.batch === null ? 'matched together' : `batch ${group.batch}`}, dated by the latest
        </span>
      </summary>
      <ul>
        {group.members.map((m) => (
          <li key={m.key}>
            <span className="mono">{m.date}</span> <span className={`mono amount ${m.direction}`}>{m.amount}</span>
            <span className="direction"> {m.direction === 'in' ? 'money in' : 'money out'}</span>
            {m.original.description && <> · {m.original.description}</>}
            <span className="muted">
              {' '}
              · {locationText(m, formats)}
              {m.carried && ` · carried from ${m.carried.fileName}`}
            </span>
          </li>
        ))}
      </ul>
      {hidden > 0 && <p className="muted">and {count(hidden)} more members, listed in the report</p>}
    </details>
  )
}
