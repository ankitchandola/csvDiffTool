import { useEffect, useRef, useState } from 'react'
import { formatDecimal, parseDecimal, subtractDecimal } from '../../engine/decimal'
import type { TxnKey } from '../../reconciliation/decisions'
import { parseDate } from '../../reconciliation/dates'
import type { MatchingRules } from '../../reconciliation/types'
import type { ReconcileClient } from '../../worker/client'
import type { InspectDetail } from '../../worker/reconcile-protocol'
import { count, formatValue } from '../format'
import { dateEvidence, evidenceText } from './evidence'
import { type Formats, locationText, SIDE_LABELS } from './location'
import { TransactionCard } from './TransactionCard'

function day(iso: string): number {
  const outcome = parseDate(iso, 'YYYY-MM-DD')
  return outcome.ok ? outcome.day : 0
}

// Amount and date difference between a bank and a books transaction, exactly.
function variance(bank: InspectDetail, books: InspectDetail): string {
  const a = parseDecimal(bank.view.amount)
  const b = parseDecimal(books.view.amount)
  const amount = a && b ? subtractDecimal(a, b) : null
  const amountText = amount === null ? 'unknown' : amount.units === 0n ? 'none' : formatDecimal(amount)
  return `Amount difference (bank − books): ${amountText}. Dates: ${dateEvidence(day(bank.view.date) - day(books.view.date))}.`
}

function Detail({ detail, rules, formats, onCopy }: { detail: InspectDetail; rules: MatchingRules; formats: Formats; onCopy: (text: string) => void }) {
  const { view } = detail
  return (
    <section className="inspect-detail" aria-label={locationText(view, formats)}>
      <h3>{locationText(view, formats)}</h3>
      <TransactionCard t={view} formats={formats} />
      <p className="note">
        {detail.match
          ? `Confirmed with ${locationText(detail.match.other, formats)} (decision ${count(detail.match.event.seq)}).`
          : 'Not in a confirmed match.'}{' '}
        {detail.rejectedPairs > 0 && `${count(detail.rejectedPairs)} rejected pair${detail.rejectedPairs === 1 ? '' : 's'}.`}
      </p>
      <h4>Source row</h4>
      <div className="table-scroll">
        <table>
          <tbody>
            {detail.headers.map((h, i) => (
              <tr key={h}>
                <th scope="row">{h}</th>
                <td>{formatValue(detail.values[i])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="secondary" onClick={() => onCopy(`${detail.headers.join('\t')}\n${detail.values.join('\t')}`)}>
        Copy source row
      </button>
      <h4>
        Open suggestions ({count(detail.alternativesTotal)}
        {detail.alternativesTotal > detail.alternatives.length ? `, first ${count(detail.alternatives.length)} shown` : ''})
      </h4>
      {detail.alternatives.length === 0 ? (
        <p className="note">None.</p>
      ) : (
        <ul className="alternatives">
          {detail.alternatives.map((alt) => {
            const other = view.side === 'bank' ? alt.books : alt.bank
            return (
              <li key={other.key}>
                {locationText(other, formats)}: {other.date}, {other.amount}
                {other.original.description ? `, ${other.original.description}` : ''} — {evidenceText(alt, rules)}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export function Inspector({
  client,
  matchId,
  keys,
  rules,
  formats,
  version,
  onClose,
}: {
  client: ReconcileClient
  matchId: number
  keys: TxnKey[]
  rules: MatchingRules
  formats: Formats
  version: number
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [details, setDetails] = useState<(InspectDetail | null)[] | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    return () => opener?.focus()
  }, [])

  useEffect(() => {
    let live = true
    client
      .call('inspect', { matchId, keys })
      .then((result) => {
        if (live) setDetails(result)
      })
      .catch((e: unknown) => {
        if (live) setStatus(e instanceof Error ? e.message : String(e))
      })
    return () => {
      live = false
    }
  }, [client, matchId, keys, version])

  const copy = (text: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => setStatus('Copied as tab-separated text.'))
      .catch(() => setStatus('This browser did not allow copying.'))

  const [bank, books] = details ?? []
  return (
    <dialog ref={dialog} className="inspector" aria-label="Transaction details" onClose={onClose}>
      <div className="inspector-head">
        <h2>Details</h2>
        <button type="button" className="secondary" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
      {!details && !status && <p className="muted">Loading…</p>}
      {details && keys.length === 2 && bank && books && <p className="note">{variance(bank, books)}</p>}
      {details?.map((detail, i) =>
        detail ? (
          <Detail key={keys[i]} detail={detail} rules={rules} formats={formats} onCopy={(text) => void copy(text)} />
        ) : (
          <p key={keys[i]} className="warning">
            {SIDE_LABELS[keys[i].startsWith('bank') ? 'bank' : 'books']} transaction: not a valid transaction in the current files.
          </p>
        ),
      )}
      {status && <p className="note" role="status">{status}</p>}
    </dialog>
  )
}
