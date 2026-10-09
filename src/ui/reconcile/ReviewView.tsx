import { AlertTriangle, ArrowLeftRight, CheckCircle2, CircleSlash, Search, XCircle } from 'lucide-react'
import { useState } from 'react'
import type { DecisionEvent, Pair, TxnKey } from '../../reconciliation/decisions'
import type { TransactionSnapshot } from '../../reconciliation/session'
import type { Direction, ReconSide } from '../../reconciliation/types'
import type { ReconcileClient } from '../../worker/client'
import type {
  ConfirmedItem,
  DecisionSummary,
  MatchSummary,
  ProblemItem,
  RejectedItem,
  ReviewItems,
  ReviewTab,
  SuggestionItem,
  UnmatchedItem,
} from '../../worker/reconcile-protocol'
import { count, counted } from '../format'
import { Select } from '../Select'
import { tabKeyTarget } from '../tabs'
import { useDebounced } from '../use-debounced'
import { History } from './History'
import { ReviewList } from './ReviewList'
import { Inspector } from './Inspector'
import type { Formats } from './location'
import { ManualPair } from './ManualPair'
import { NO_SELECTION, type Selection, toggle } from './selection'
import { reviewKeys } from './review-keys'
import { eventText } from './review-text'
import { ConfirmedRow, type Decide, ProblemRow, RejectedRow, SuggestionRow, UnmatchedRow } from './ReviewRows'
import { SetConfirm } from './SetConfirm'

const TABS: [ReviewTab, string, typeof Search][] = [
  ['suggested', 'Suggested', ArrowLeftRight],
  ['confirmed', 'Confirmed', CheckCircle2],
  ['unmatched', 'Unmatched', CircleSlash],
  ['rejected', 'Rejected', XCircle],
  ['problems', 'Problems', AlertTriangle],
]

export function ReviewView({
  client,
  summary,
  decisions,
  version,
  events,
  snapshots,
  busy,
  error,
  formats,
  onDecide,
  onDecideSet,
}: {
  client: ReconcileClient
  summary: MatchSummary
  decisions: DecisionSummary
  // Changes with every recorded decision, so lists fetch again.
  version: number
  events: DecisionEvent[]
  snapshots: Map<string, TransactionSnapshot>
  busy: boolean
  error: string | null
  formats: Formats
  onDecide: Decide
  onDecideSet: (group: number, pairs: Pair[]) => Promise<string | null>
}) {
  const [tab, setTab] = useState<ReviewTab>('suggested')
  const [inspecting, setInspecting] = useState<TxnKey[] | null>(null)
  const [openSet, setOpenSet] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [direction, setDirection] = useState<Direction | ''>('')
  const [selection, setSelection] = useState<Selection>(NO_SELECTION)
  const search = useDebounced(query, 250)
  const both = (r: Record<ReconSide, number>) => r.bank + r.books
  const totals: Record<ReviewTab, number> = {
    suggested: decisions.suggested,
    confirmed: decisions.confirmed,
    unmatched: both(decisions.unmatched),
    rejected: decisions.rejected,
    problems: both(summary.invalid) + both(summary.zero),
  }
  const fetchPage = <T extends ReviewTab>(which: T) => (offset: number, limit: number) =>
    client
      .call('getReview', { matchId: summary.matchId, tab: which, offset, limit, search, ...(direction && which !== 'problems' ? { direction } : {}) })
      .then((page) => ({ total: page.total, items: page.items as ReviewItems[T][] }))
  const listKey = `${summary.matchId}-${tab}-${search}-${direction}`
  const filteredNote = (unit: string, plural?: string) => (total: number) => (search || direction ? `${counted(total, unit, plural)} shown for these filters.` : null)
  const placeholder = <div className="cell">…</div>

  return (
    <section className="panel results-panel review-panel" aria-label="Review">
      {decisions.lapsed.length > 0 && (
        <details className="warning lapsed">
          <summary>
            {counted(decisions.lapsed.length, 'earlier decision')} no longer {decisions.lapsed.length === 1 ? 'applies' : 'apply'}
          </summary>
          <p>They stay in the history but are not in force. Confirm or reject again where needed.</p>
          <ul>
            {decisions.lapsed.map(({ event, reason }) => (
              <li key={event.seq}>
                {eventText(event)}: {reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="tabs" role="tablist" aria-label="Review">
        {TABS.map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`recon-tab-${id}`}
            aria-controls="recon-panel"
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? 'tab active' : 'tab'}
            onClick={() => setTab(id)}
            onKeyDown={(e) => {
              const next = tabKeyTarget(e.key, TABS.findIndex(([key]) => key === id), TABS.length)
              if (next === null) return
              e.preventDefault()
              setTab(TABS[next][0])
              document.getElementById(`recon-tab-${TABS[next][0]}`)?.focus()
            }}
          >
            <Icon size={16} />
            {label} <span className="tab-count">{count(totals[id])}</span>
          </button>
        ))}
      </div>
      <div className="row result-search">
        <Search size={16} aria-hidden="true" />
        <input type="search" aria-label="Search this tab" placeholder="Search dates, amounts, references and descriptions" value={query} onChange={(e) => setQuery(e.target.value)} />
        {tab !== 'problems' && (
          <Select<Direction | ''>
            label="Cash direction"
            value={direction}
            onChange={setDirection}
            options={[
              { value: '', label: 'Money in and out' },
              { value: 'in', label: 'Money in' },
              { value: 'out', label: 'Money out' },
            ]}
          />
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div id="recon-panel" role="tabpanel" aria-labelledby={`recon-tab-${tab}`} onKeyDown={reviewKeys}>
        {tab === 'suggested' && (
          <>
            <p className="note">
              Counts are candidate pairs still open. Pairs in the same group compete; confirming one removes the others that share a transaction.
              Keys: J/K or ↓/↑ move, C confirms, X rejects, Enter shows details of the focused pair.
            </p>
            {openSet !== null && (
              <SetConfirm
                client={client}
                matchId={summary.matchId}
                group={openSet}
                version={version}
                busy={busy}
                formats={formats}
                onConfirm={onDecideSet}
                onClose={() => setOpenSet(null)}
              />
            )}
            <ReviewList<SuggestionItem>
              key={listKey}
              version={version}
              fetchPage={fetchPage('suggested')}
              estimateSize={170}
              empty="No open suggestions."
              label="Suggested pairs"
              summary={filteredNote('pair')}
              renderRow={(item) =>
                item ? (
                  <SuggestionRow item={item} rules={summary.rules} formats={formats} busy={busy} onDecide={onDecide} onInspect={setInspecting} onOpenSet={setOpenSet} />
                ) : (
                  placeholder
                )
              }
            />
          </>
        )}
        {tab === 'confirmed' && (
          <>
            <p className="note">Confirmed by you in this session. Each transaction belongs to at most one confirmed match.</p>
            <ReviewList<ConfirmedItem>
              key={listKey}
              version={version}
              fetchPage={fetchPage('confirmed')}
              estimateSize={170}
              empty="Nothing confirmed yet."
              label="Confirmed matches"
              summary={filteredNote('match', 'matches')}
              renderRow={(item) => (item ? <ConfirmedRow item={item} rules={summary.rules} formats={formats} busy={busy} onDecide={onDecide} onInspect={setInspecting} /> : placeholder)}
            />
          </>
        )}
        {tab === 'unmatched' && (
          <>
            <ManualPair
              client={client}
              matchId={summary.matchId}
              selection={selection}
              formats={formats}
              busy={busy}
              onDecide={onDecide}
              onClear={() => setSelection(NO_SELECTION)}
            />
            <p className="note">
              Valid transactions not in a confirmed match. Classify each one that stays unmatched: completion needs them all classified. O applies
              the usual classification to the focused row.
            </p>
            <ReviewList<UnmatchedItem>
              key={listKey}
              version={version}
              fetchPage={fetchPage('unmatched')}
              estimateSize={110}
              empty="Every valid transaction is in a confirmed match."
              label="Unmatched transactions"
              summary={filteredNote('transaction')}
              renderRow={(t) =>
                t ? (
                  <UnmatchedRow
                    t={t}
                    formats={formats}
                    busy={busy}
                    selected={selection[t.side].some((c) => c.key === t.key)}
                    onSelect={() => setSelection((prev) => toggle(prev, t))}
                    onDecide={onDecide}
                    onInspect={setInspecting}
                  />
                ) : (
                  placeholder
                )
              }
            />
          </>
        )}
        {tab === 'rejected' && (
          <>
            <p className="note">Rejected pairs stay hidden from suggestions after reruns and rule changes, until restored or a source file is replaced.</p>
            <ReviewList<RejectedItem>
              key={listKey}
              version={version}
              fetchPage={fetchPage('rejected')}
              estimateSize={150}
              empty="No rejected pairs."
              label="Rejected pairs"
              summary={filteredNote('pair')}
              renderRow={(item) => (item ? <RejectedRow item={item} formats={formats} busy={busy} onDecide={onDecide} onInspect={setInspecting} /> : placeholder)}
            />
          </>
        )}
        {tab === 'problems' && (
          <>
            <p className="note">Records that cannot be matched: invalid dates or amounts, and zero amounts kept out of matching. Counts are source records.</p>
            <ReviewList<ProblemItem>
              key={listKey}
              version={version}
              fetchPage={fetchPage('problems')}
              estimateSize={90}
              empty="No problems."
              label="Problem records"
              summary={(total) => (search ? `${counted(total, 'record')} shown for this search.` : null)}
              renderRow={(p) => (p ? <div className="cell"><ProblemRow item={p} formats={formats} /></div> : placeholder)}
            />
          </>
        )}
      </div>
      {inspecting && (
        <Inspector
          client={client}
          matchId={summary.matchId}
          keys={inspecting}
          rules={summary.rules}
          formats={formats}
          version={version}
          onClose={() => setInspecting(null)}
        />
      )}
      <History events={events} snapshots={snapshots} />
    </section>
  )
}
