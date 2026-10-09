import { ArrowLeftRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { EXCEPTION_LABELS } from '../../reconciliation/decisions'
import { RECON_SIDES, type ReconSide } from '../../reconciliation/types'
import type { ReconcileClient } from '../../worker/client'
import type { PairCheckResult, UnmatchedItem } from '../../worker/reconcile-protocol'
import { errorMessage } from '../browser'
import { counted } from '../format'
import { type Formats, SIDE_LABELS } from './location'
import type { Decide } from './ReviewRows'
import { type Selection, selectedUnit } from './selection'
import { TransactionCard } from './TransactionCard'

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
  const [checkError, setCheckError] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const bank = selectedUnit(selection.bank)
  const books = selectedUnit(selection.books)
  const bankKey = bank && 'key' in bank ? bank.key : undefined
  const booksKey = books && 'key' in books ? books.key : undefined
  useEffect(() => {
    if (!bankKey || !booksKey) return
    let live = true
    client.call('checkPair', { matchId, bank: bankKey, books: booksKey }).then(
      (result) => {
        if (live) setCheck(result)
      },
      (error: unknown) => {
        if (live) setCheckError(errorMessage(error))
      },
    )
    return () => {
      live = false
      setCheck(null)
      setCheckError(null)
    }
  }, [client, matchId, bankKey, booksKey])
  const needsReason = (check?.exceptions.length ?? 0) > 0
  const grouped = selection.bank.length > 1 || selection.books.length > 1
  const selectionError = [bank, books].map((u) => (u && 'error' in u ? u.error : null)).find((e) => e !== null) ?? null
  const competing = [...selection.bank, ...selection.books].filter((t) => t.suggestions > 0).length
  const what = grouped ? 'group' : 'pair'
  return (
    <section className="manual-pair" aria-label="Manual pair">
      <p className="note">
        Select one bank and one books transaction below to pair them by hand, or several on one side to match their total against one on the
        other.
      </p>
      <div className="pair">
        {RECON_SIDES.map((side, i) => (
          <SideSelection key={side} side={side} chosen={selection[side]} checked={side === 'bank' ? check?.bank : check?.books} formats={formats} arrow={i === 1} />
        ))}
      </div>
      {selectionError && <p className="error" role="alert">{selectionError}</p>}
      {checkError && <p className="error" role="alert">{checkError}</p>}
      {check?.blocked && <p className="error" role="alert">{check.blocked}</p>}
      {check && !check.blocked && (
        <>
          <p className={needsReason ? 'warning' : 'note'}>
            {needsReason
              ? `This ${what} breaks the rules: ${check.exceptions.map((e) => EXCEPTION_LABELS[e]).join(', ')}. Give a reason.`
              : `This ${what} meets the matching rules.`}
          </p>
          {competing > 0 && (
            <p className="warning">
              {counted(competing, 'selected transaction is', 'selected transactions are')} also in open suggestions; confirming this {what} withdraws
              them.
            </p>
          )}
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
          {grouped ? 'Confirm group' : 'Confirm manual pair'}
        </button>
        {(selection.bank.length > 0 || selection.books.length > 0) && (
          <button type="button" className="secondary" onClick={onClear}>
            Clear selection
          </button>
        )}
      </div>
    </section>
  )
}

function SideSelection({
  side,
  chosen,
  checked,
  formats,
  arrow,
}: {
  side: ReconSide
  chosen: UnmatchedItem[]
  checked: PairCheckResult['bank'] | undefined
  formats: Formats
  arrow: boolean
}) {
  const body =
    chosen.length === 0 ? (
      <div className="txn muted">No {SIDE_LABELS[side].toLowerCase()} transaction selected</div>
    ) : checked ? (
      <TransactionCard t={checked} formats={formats} />
    ) : (
      <div className="selected-list">
        {chosen.map((t) => (
          <TransactionCard key={t.key} t={t} formats={formats} />
        ))}
      </div>
    )
  return (
    <>
      {arrow && <ArrowLeftRight size={16} aria-hidden="true" className="pair-arrow" />}
      {body}
    </>
  )
}
