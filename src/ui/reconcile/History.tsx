import { useState } from 'react'
import { type DecisionEvent, eventKeys } from '../../reconciliation/decisions'
import type { TransactionSnapshot } from '../../reconciliation/session'
import { count } from '../format'
import { eventText } from './review-text'

const HISTORY_SHOWN = 500

// Built only while open, and only the latest entries: a long session's history would
// otherwise be redrawn on every decision. The full history is in backups and reports.
export function History({ events, snapshots }: { events: DecisionEvent[]; snapshots: Map<string, TransactionSnapshot> }) {
  const [open, setOpen] = useState(false)
  const latest = open ? events.slice(-HISTORY_SHOWN).reverse() : []
  return (
    <details className="history" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Decision history ({count(events.length)})</summary>
      {open &&
        (events.length === 0 ? (
          <p className="note">No decisions yet.</p>
        ) : (
          <>
            {events.length > HISTORY_SHOWN && (
              <p className="note">
                Showing the latest {count(HISTORY_SHOWN)}. The session backup and the report hold all {count(events.length)}.
              </p>
            )}
            <ol reversed start={events.length}>
              {latest.map((event) => (
                <li key={event.seq}>
                  {eventText(event)}
                  {eventKeys(event).map((key) => snapshots.get(key)?.description).filter(Boolean).slice(0, 1).map((description) => (
                    <span key="description" className="muted"> · {description}</span>
                  ))}
                </li>
              ))}
            </ol>
          </>
        ))}
    </details>
  )
}
