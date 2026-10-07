import type { TransactionView } from '../../worker/reconcile-protocol'
import { formatValue } from '../format'
import { type Formats, locationText, originalAmount } from './location'

export function TransactionCard({ t, formats }: { t: TransactionView; formats: Formats }) {
  return (
    <div className="txn">
      <div className="txn-main">
        <span className="mono">{t.date}</span>
        <span className={`mono amount ${t.direction}`}>{t.amount}</span>
        <span className="muted">{t.direction === 'in' ? 'money in' : 'money out'}</span>
      </div>
      {(t.reference !== null || t.original.description) && (
        <div className="txn-context">
          {t.reference !== null && <span className="mono">Ref {t.reference}</span>}
          {t.original.description && <span>{t.original.description}</span>}
        </div>
      )}
      <div className="txn-source muted">
        {locationText(t, formats)} · as written: {formatValue(t.original.date)}, {originalAmount(t.original)}
      </div>
    </div>
  )
}
