import { ArrowLeftRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type Pair, pairSet, type TxnKey } from '../../reconciliation/decisions'
import type { ReconSide } from '../../reconciliation/types'
import type { ReconcileClient } from '../../worker/client'
import type { SetView } from '../../worker/reconcile-protocol'
import { count, counted } from '../format'
import { type Formats, locationText, SIDE_LABELS } from './location'
import { TransactionCard } from './TransactionCard'

type Chosen = Record<ReconSide, TxnKey[]>

// Rows of the larger side that stay unmatched become outstanding with their own source
// rows, so the reviewer chooses them; by default the latest by source location stay.
export function SetConfirm({
  client,
  matchId,
  group,
  version,
  busy,
  formats,
  onConfirm,
  onClose,
}: {
  client: ReconcileClient
  matchId: number
  group: number
  version: number
  busy: boolean
  formats: Formats
  onConfirm: (group: number, pairs: Pair[]) => Promise<string | null>
  onClose: () => void
}) {
  const [set, setSet] = useState<SetView | null>(null)
  const [chosen, setChosen] = useState<Chosen>({ bank: [], books: [] })
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    client
      .call('getSet', { matchId, group })
      .then((result) => {
        if (!live) return
        const size = Math.min(result.bank.length, result.books.length)
        setSet(result)
        setChosen({ bank: result.bank.slice(0, size).map((v) => v.key), books: result.books.slice(0, size).map((v) => v.key) })
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      live = false
    }
  }, [client, matchId, group, version])

  if (error) return <p className="error" role="alert">{error}</p>
  if (!set) return <p className="muted">Loading the set…</p>
  const size = Math.min(set.bank.length, set.books.length)
  const larger: ReconSide | null = set.bank.length > set.books.length ? 'bank' : set.books.length > set.bank.length ? 'books' : null
  const ordered = (side: ReconSide) => set[side].filter((v) => chosen[side].includes(v.key)).map((v) => v.key)
  const ready = chosen.bank.length === size && chosen.books.length === size
  const pairs = ready ? pairSet(ordered('bank'), ordered('books')) : []
  const label = (key: TxnKey, side: ReconSide) => {
    const v = set[side].find((x) => x.key === key)
    return v ? locationText(v, formats) : key
  }

  return (
    <section className="set-confirm" aria-label={`Confirm set ${group + 1}`}>
      <h3>Confirm set {count(group + 1)}</h3>
      {set.blocked ? (
        <p className="warning">{set.blocked}</p>
      ) : (
        <>
          <p className="note">
            On each side these transactions share the same date, amount, reference and description, so any pairing is economically the same.
            Pairs are assigned in source order; which bank row pairs with which books row is arbitrary, not evidence.
          </p>
          <p className="set-counts">
            {counted(set.bank.length, 'bank transaction')} · {counted(set.books.length, 'books transaction')} still open
          </p>
          <div className="pair">
            <TransactionCard t={set.bank[0]} formats={formats} />
            <ArrowLeftRight size={16} aria-hidden="true" className="pair-arrow" />
            <TransactionCard t={set.books[0]} formats={formats} />
          </div>
          {larger && (
            <fieldset className="set-choice">
              <legend>
                Choose the {counted(size, `${SIDE_LABELS[larger].toLowerCase()} transaction`)} to pair.{' '}
                {set[larger].length - size === 1 ? 'The other one stays' : `The other ${count(set[larger].length - size)} stay`} unmatched, each
                with its own source row.
              </legend>
              {set[larger].map((v) => {
                const checked = chosen[larger].includes(v.key)
                return (
                  <label key={v.key} className="choice">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && chosen[larger].length >= size}
                      onChange={() =>
                        setChosen((prev) => ({ ...prev, [larger]: checked ? prev[larger].filter((k) => k !== v.key) : [...prev[larger], v.key] }))
                      }
                    />{' '}
                    {locationText(v, formats)}
                  </label>
                )
              })}
            </fieldset>
          )}
          {ready && (
            <ol className="set-pairs">
              {pairs.map((p) => (
                <li key={p.bank}>
                  {label(p.bank, 'bank')} ↔ {label(p.books, 'books')}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        {!set.blocked && (
          <button
            type="button"
            className="primary"
            disabled={busy || !ready}
            onClick={async () => {
              const failure = await onConfirm(group, pairs)
              if (failure) setError(failure)
              else onClose()
            }}
          >
            Confirm {counted(size, 'pair')}
          </button>
        )}
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  )
}
