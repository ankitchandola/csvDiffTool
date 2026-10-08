import { ArrowLeftRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { EXCEPTION_LABELS } from '../../reconciliation/decisions'
import type { ReconSide } from '../../reconciliation/types'
import type { ReconcileClient } from '../../worker/client'
import type { PairCheckResult, UnmatchedItem } from '../../worker/reconcile-protocol'
import type { Formats } from './location'
import type { Decide } from './ReviewRows'
import { TransactionCard } from './TransactionCard'

export type Selection = Partial<Record<ReconSide, UnmatchedItem>>

export function ManualPair({
  client,
  matchId,
  selection,
  formats,
  busy,
  onDecide,
  onClear,
}: {
  client: ReconcileClient
  matchId: number
  selection: Selection
  formats: Formats
  busy: boolean
  onDecide: Decide
  onClear: () => void
}) {
  const [check, setCheck] = useState<PairCheckResult | null>(null)
  const [reason, setReason] = useState('')
  const bankKey = selection.bank?.key
  const booksKey = selection.books?.key
  useEffect(() => {
    if (!bankKey || !booksKey) return
    let live = true
    client.call('checkPair', { matchId, bank: bankKey, books: booksKey }).then((result) => {
      if (live) setCheck(result)
    })
    return () => {
      live = false
      setCheck(null)
    }
  }, [client, matchId, bankKey, booksKey])
  const needsReason = (check?.exceptions.length ?? 0) > 0
  return (
    <section className="manual-pair" aria-label="Manual pair">
      <p className="note">Select one bank and one books transaction below to pair them by hand.</p>
      <div className="pair">
        {selection.bank ? <TransactionCard t={selection.bank} formats={formats} /> : <div className="txn muted">No bank transaction selected</div>}
        <ArrowLeftRight size={16} aria-hidden="true" className="pair-arrow" />
        {selection.books ? <TransactionCard t={selection.books} formats={formats} /> : <div className="txn muted">No books transaction selected</div>}
      </div>
      {check?.blocked && <p className="error" role="alert">{check.blocked}</p>}
      {check && !check.blocked && (
        <>
          <p className={needsReason ? 'warning' : 'note'}>
            {needsReason ? `This pair breaks the rules: ${check.exceptions.map((e) => EXCEPTION_LABELS[e]).join(', ')}. Give a reason.` : 'This pair meets the matching rules.'}
          </p>
          {needsReason && (
            <label className="field">
              <span>Reason</span>
              <textarea value={reason} rows={2} onChange={(e) => setReason(e.target.value)} />
            </label>
          )}
        </>
      )}
      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={busy || !check || check.blocked !== null || (needsReason && reason.trim() === '')}
          onClick={async () => {
            if (!bankKey || !booksKey || !check) return
            const error = await onDecide({
              action: 'confirm',
              bank: bankKey,
              books: booksKey,
              origin: 'manual',
              ...(needsReason ? { exceptions: check.exceptions, reason: reason.trim() } : {}),
            })
            if (error === null) {
              setReason('')
              onClear()
            }
          }}
        >
          Confirm manual pair
        </button>
        {(selection.bank || selection.books) && (
          <button type="button" className="secondary" onClick={onClear}>
            Clear selection
          </button>
        )}
      </div>
    </section>
  )
}
