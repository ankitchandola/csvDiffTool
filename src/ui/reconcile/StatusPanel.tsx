import { CheckCircle2, CircleDashed } from 'lucide-react'
import { useEffect, useState } from 'react'
import { formatDecimal } from '../../engine/decimal'
import type { DecisionEvent } from '../../reconciliation/decisions'
import type { AccountingSetup } from '../../reconciliation/session'
import type { Status } from '../../reconciliation/statuses'
import type { ReconcileClient } from '../../worker/client'
import { RECON_SIDES } from '../../reconciliation/types'
import type { AccountingReport } from '../../worker/reconcile-protocol'
import { SIDE_LABELS } from './location'

const LABELS: [keyof Omit<AccountingReport['statuses'], 'canMarkComplete'>, string][] = [
  ['sourcesValidated', 'Source balances validated'],
  ['bridgeComplete', 'Balance bridge complete'],
  ['outstandingReviewed', 'Outstanding items reviewed'],
  ['completed', 'Reconciliation completed'],
]

function StatusLine({ label, status }: { label: string; status: Status }) {
  return (
    <li className={status.earned ? 'status earned' : 'status'}>
      {status.earned ? <CheckCircle2 size={16} aria-hidden="true" /> : <CircleDashed size={16} aria-hidden="true" />}
      <span>
        <strong>{label}</strong>: {status.earned ? 'yes' : 'not yet'}
        {status.reasons.length > 0 && <span className="muted"> — {status.reasons.join('; ')}</span>}
      </span>
    </li>
  )
}

export function StatusPanel({
  client,
  matchId,
  setup,
  basis,
  version,
  busy,
  nextSeq,
  onCompleted,
  sessionId,
  revision,
  onDownload,
}: {
  client: ReconcileClient
  matchId: number
  setup: AccountingSetup
  // Fingerprint of the setup now; a completion made for another one no longer holds.
  basis: string
  // Changes with every recorded decision.
  version: number
  busy: boolean
  nextSeq: () => number
  onCompleted: (event: DecisionEvent) => void
  sessionId: string
  revision: number
  onDownload: (content: string | Blob, fileName: string) => void
}) {
  const [report, setReport] = useState<AccountingReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const setupJson = JSON.stringify(setup)
  useEffect(() => {
    let live = true
    client
      .call('accounting', { matchId, setup: JSON.parse(setupJson) as AccountingSetup, basis })
      .then((result) => {
        if (live) {
          setReport(result)
          setError(null)
        }
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      live = false
    }
  }, [client, matchId, setupJson, basis, version])

  // The report states every status as it is now, completed or not.
  async function downloadReport(format: 'json' | 'xlsx') {
    try {
      const generatedAt = new Date().toISOString()
      const blob = await client.call('exportReport', { matchId, format, setup, basis, session: { id: sessionId, revision }, generatedAt })
      onDownload(blob, `reconciliation-report-${setup.period?.end ?? generatedAt.slice(0, 10)}.${format}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (!report) return error ? <p className="error" role="alert">{error}</p> : null
  const { bridge, statuses } = report
  return (
    <section className="status-panel" aria-label="Reconciliation status">
      <ul className="statuses">
        {LABELS.map(([key, label]) => (
          <StatusLine key={key} label={label} status={statuses[key]} />
        ))}
      </ul>
      {report.balanceErrors.map((message) => (
        <p key={message} className="error">
          {message}
        </p>
      ))}
      <p className="note">
        Closing difference (bank − books): {bridge.actual === null ? 'needs both closing balances' : formatDecimal(bridge.actual)}. Explained by
        unmatched items and variances: {formatDecimal(bridge.explained)}.
        {bridge.unexplained !== null && bridge.unexplained.units !== 0n && ` Unexplained: ${formatDecimal(bridge.unexplained)}.`}
      </p>
      {RECON_SIDES.map((side) => {
        const check = report.running[side]
        if (!check) return null
        return (
          <p key={side} className={check.status === 'consistent' ? 'note' : 'warning'}>
            {SIDE_LABELS[side]} running balance:{' '}
            {check.status === 'consistent'
              ? 'consistent with every row'
              : check.status === 'break'
                ? `breaks at record ${check.first.row}: expected ${formatDecimal(check.first.expected)}, found ${formatDecimal(check.first.found)}. A row may be missing, extra or out of order.`
                : `can't be checked past record ${check.row}, which has no valid amount or balance.`}
          </p>
        )
      })}
      <p className="note">
        A balancing bridge alone proves nothing: it balances whenever every transaction is either matched or unmatched. Completion also needs
        every unmatched item classified and your mark.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button
          type="button"
          disabled={busy || setup.period === null}
          title={setup.period === null ? 'Enter the period on the Map step first' : undefined}
          onClick={async () => {
            if (!setup.period) return
            try {
              const result = await client.call('exportOutstanding', { matchId, sessionId, period: setup.period, exportedAt: new Date().toISOString() })
              onDownload(result.text, `outstanding-${setup.period.end}.json`)
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            }
          }}
        >
          Export outstanding items
        </button>
        <button type="button" disabled={busy} onClick={() => void downloadReport('json')}>
          Report (JSON)
        </button>
        <button type="button" disabled={busy} onClick={() => void downloadReport('xlsx')}>
          Report (Excel)
        </button>
        <span className="note">
          {setup.period === null
            ? 'Needs the period.'
            : statuses.completed.earned
              ? "For the next period's opening items."
              : 'Not marked complete yet: the file will carry whatever is unmatched now.'}
        </span>
      </div>
      {!statuses.completed.earned && (
        <button
          type="button"
          className="primary"
          disabled={busy || !statuses.canMarkComplete}
          onClick={async () => {
            try {
              const result = await client.call('markComplete', { matchId, seq: nextSeq(), at: new Date().toISOString(), setup, basis })
              if (!result.ok) setError(result.reason)
              else {
                setReport(result.report)
                onCompleted(result.event)
              }
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            }
          }}
        >
          Mark reconciliation complete
        </button>
      )}
    </section>
  )
}
