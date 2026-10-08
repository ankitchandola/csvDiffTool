import { AlertTriangle, ArrowLeftRight, CheckCircle2, CircleSlash, Search, XCircle } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useEffect, useState } from 'react'
import { type Classification, CLASSIFICATION_LABELS, classificationsFor, type DecisionEvent, eventKeys, EXCEPTION_LABELS, type Pair, type PairEvent, type TxnKey } from '../../reconciliation/decisions'
import type { TransactionSnapshot } from '../../reconciliation/session'
import type { Direction, MatchingRules, ReconSide } from '../../reconciliation/types'
import type { ReconcileClient } from '../../worker/client'
import type {
  ConfirmedItem,
  DecisionInput,
  DecisionSummary,
  MatchSummary,
  PairCheckResult,
  ProblemItem,
  RejectedItem,
  ReviewItems,
  ReviewTab,
  SuggestionItem,
  UnmatchedItem,
} from '../../worker/reconcile-protocol'
import { count, counted, formatValue } from '../format'
import { VirtualList } from '../results/VirtualList'
import { Select } from '../Select'
import { tabKeyTarget } from '../tabs'
import { useDebounced } from '../use-debounced'
import { competitionText, dateEvidence, evidenceText } from './evidence'
import { type Formats, keyLabel, locationText, originalAmount } from './location'
import { Inspector } from './Inspector'
import { SetConfirm } from './SetConfirm'
import { TransactionCard } from './TransactionCard'

// Resolves to an error message, or null once the decision is recorded.
export type Decide = (decision: DecisionInput) => Promise<string | null>

function Missing({ keyText }: { keyText: string }) {
  return <div className="txn muted">{keyLabel(keyText)}: not a valid transaction in the current files</div>
}

// A focusable row whose buttons the review shortcuts press; nothing acts on a row
// that doesn't have focus.
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="review-row" tabIndex={0} data-row aria-label={label}>
      {children}
    </div>
  )
}

type Inspect = (keys: TxnKey[]) => void

function DetailsButton({ keys, onInspect }: { keys: TxnKey[]; onInspect: Inspect }) {
  return (
    <button type="button" className="secondary" data-action="inspect" aria-keyshortcuts="Enter" onClick={() => onInspect(keys)}>
      Details
    </button>
  )
}

function SuggestionRow({
  item,
  rules,
  formats,
  busy,
  onDecide,
  onInspect,
  onOpenSet,
}: {
  item: SuggestionItem
  rules: MatchingRules
  formats: Formats
  busy: boolean
  onDecide: Decide
  onInspect: Inspect
  onOpenSet: (group: number) => void
}) {
  const pair = { bank: item.bank.key, books: item.books.key }
  return (
    <Row label={`Suggested pair: ${locationText(item.bank, formats)} and ${locationText(item.books, formats)}`}>
      <div className="suggestion">
        <div className="group-label">
          <span className={item.unique ? 'chip' : 'chip competing'}>Group {count(item.group + 1)}</span>
          <span className="muted">{competitionText(item)}</span>
          {item.set === 'interchangeable' && <span className="chip">Identical set</span>}
          {item.set === 'different-descriptions' && <span className="muted">Identical amounts and dates, different descriptions: review pair by pair.</span>}
        </div>
        <div className="pair">
          <TransactionCard t={item.bank} formats={formats} />
          <ArrowLeftRight size={16} aria-hidden="true" className="pair-arrow" />
          <TransactionCard t={item.books} formats={formats} />
        </div>
        <div className="row-actions">
          <p className="evidence">{evidenceText(item, rules)}</p>
          <button type="button" data-action="confirm" aria-keyshortcuts="C" disabled={busy} onClick={() => void onDecide({ action: 'confirm', ...pair, origin: 'suggested' })}>
            <CheckCircle2 size={15} aria-hidden="true" /> Confirm
          </button>
          <button type="button" className="secondary" data-action="reject" aria-keyshortcuts="X" disabled={busy} onClick={() => void onDecide({ action: 'reject', ...pair })}>
            <XCircle size={15} aria-hidden="true" /> Reject
          </button>
          {item.set === 'interchangeable' && (
            <button type="button" className="secondary" disabled={busy} onClick={() => onOpenSet(item.group)}>
              Confirm set…
            </button>
          )}
          <DetailsButton keys={[pair.bank, pair.books]} onInspect={onInspect} />
        </div>
      </div>
    </Row>
  )
}

const SHORT_CLASSIFICATIONS: Record<Classification, string> = {
  'outstanding-payment': 'Outstanding payment',
  'deposit-in-transit': 'Deposit in transit',
  'record-in-books': 'Record in books',
  investigate: 'Investigate',
}

function ClassifyControls({ t, formats, busy, onDecide }: { t: UnmatchedItem; formats: Formats; busy: boolean; onDecide: Decide }) {
  const options = classificationsFor(t.side, t.direction)
  const current = t.classification?.value ?? ''
  const choose = (value: Classification | '') => {
    if (value === current) return
    void onDecide({ action: 'classify', key: t.key, classification: value === '' ? null : value })
  }
  return (
    <>
      {t.classification ? (
        <span className="chip" title={CLASSIFICATION_LABELS[t.classification.value]}>
          {SHORT_CLASSIFICATIONS[t.classification.value]}
        </span>
      ) : (
        <button type="button" className="secondary" data-action="classify" aria-keyshortcuts="O" disabled={busy} onClick={() => choose(options[0])}>
          {SHORT_CLASSIFICATIONS[options[0]]}
        </button>
      )}
      <Select<Classification | ''>
        label={`Classification for ${locationText(t, formats)}`}
        value={current}
        disabled={busy}
        onChange={choose}
        options={[{ value: '', label: 'Not classified' }, ...options.map((value) => ({ value, label: CLASSIFICATION_LABELS[value] }))]}
      />
    </>
  )
}

function decisionNote(event: PairEvent): string {
  if (event.origin === 'set') return 'Confirmed as part of an identical set; the pairing within the set is arbitrary'
  if (event.origin !== 'manual') return 'Confirmed from a suggestion'
  const broken = (event.exceptions ?? []).map((e) => EXCEPTION_LABELS[e])
  return `Manual pair${broken.length > 0 ? `: ${broken.join(', ')}` : ''}${event.reason ? ` — “${event.reason}”` : ''}`
}

function ConfirmedRow({ item, rules, formats, busy, onDecide, onInspect }: { item: ConfirmedItem; rules: MatchingRules; formats: Formats; busy: boolean; onDecide: Decide; onInspect: Inspect }) {
  const evidence =
    item.tier === null
      ? `Outside the rules: ${dateEvidence(item.gap)}.`
      : evidenceText({ tier: item.tier, gap: item.gap, bank: item.bank, books: item.books }, rules)
  return (
    <Row label={`Confirmed match: ${locationText(item.bank, formats)} and ${locationText(item.books, formats)}`}>
      <div className="suggestion">
        <div className="group-label">
          <span className={item.event.origin === 'manual' ? 'chip competing' : 'chip'}>Decision {count(item.event.seq)}</span>
          <span className="muted">{decisionNote(item.event)}</span>
        </div>
        <div className="pair">
          <TransactionCard t={item.bank} formats={formats} />
          <ArrowLeftRight size={16} aria-hidden="true" className="pair-arrow" />
          <TransactionCard t={item.books} formats={formats} />
        </div>
        <div className="row-actions">
          <p className="evidence">{evidence}</p>
          <button type="button" className="secondary" data-action="unmatch" disabled={busy} onClick={() => void onDecide({ action: 'unmatch', bank: item.bank.key, books: item.books.key })}>
            Unmatch
          </button>
          <DetailsButton keys={[item.bank.key, item.books.key]} onInspect={onInspect} />
        </div>
      </div>
    </Row>
  )
}

function RejectedRow({ item, formats, busy, onDecide, onInspect }: { item: RejectedItem; formats: Formats; busy: boolean; onDecide: Decide; onInspect: Inspect }) {
  return (
    <Row label={`Rejected pair: ${keyLabel(item.bankKey)} and ${keyLabel(item.booksKey)}`}>
      <div className="suggestion">
        <div className="group-label">
          <span className="chip competing">Decision {count(item.event.seq)}</span>
          <span className="muted">Rejected; hidden from suggestions</span>
        </div>
        <div className="pair">
          {item.bank ? <TransactionCard t={item.bank} formats={formats} /> : <Missing keyText={item.bankKey} />}
          <ArrowLeftRight size={16} aria-hidden="true" className="pair-arrow" />
          {item.books ? <TransactionCard t={item.books} formats={formats} /> : <Missing keyText={item.booksKey} />}
        </div>
        <div className="row-actions">
          <span />
          <button type="button" className="secondary" data-action="restore" disabled={busy} onClick={() => void onDecide({ action: 'restore', bank: item.bankKey, books: item.booksKey })}>
            Restore suggestion
          </button>
          <DetailsButton keys={[item.bankKey, item.booksKey]} onInspect={onInspect} />
        </div>
      </div>
    </Row>
  )
}

function ProblemRow({ item, formats }: { item: ProblemItem; formats: Formats }) {
  return (
    <div className={`problem-row ${item.kind}`}>
      <div className="muted">{locationText(item, formats)}</div>
      <ul>
        {item.messages.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
      <div className="muted">
        As written: date {formatValue(item.original.date)}, amount {originalAmount(item.original)}
        {item.original.reference !== null && `, reference ${formatValue(item.original.reference)}`}
        {item.original.description !== null && `, ${formatValue(item.original.description)}`}
      </div>
    </div>
  )
}

type Selection = Partial<Record<ReconSide, UnmatchedItem>>

function ManualPair({
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

const TABS: [ReviewTab, string, typeof Search][] = [
  ['suggested', 'Suggested', ArrowLeftRight],
  ['confirmed', 'Confirmed', CheckCircle2],
  ['unmatched', 'Unmatched', CircleSlash],
  ['rejected', 'Rejected', XCircle],
  ['problems', 'Problems', AlertTriangle],
]

const IGNORE_KEYS_IN = 'input, textarea, [role="combobox"], [role="tab"]'

// J/K or the arrow keys move between rows; C confirms, X rejects, O classifies an
// unmatched row the usual way, and Enter opens the details of the focused row.
function reviewKeys(event: KeyboardEvent<HTMLElement>) {
  const target = event.target as HTMLElement
  if (target.closest(IGNORE_KEYS_IN) || event.altKey || event.ctrlKey || event.metaKey) return
  const row = target.closest<HTMLElement>('[data-row]')
  const key = event.key.toLowerCase()
  if (key === 'j' || key === 'arrowdown' || key === 'k' || key === 'arrowup') {
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-row]')]
    if (rows.length === 0) return
    const index = row ? rows.indexOf(row) : -1
    const next = key === 'j' || key === 'arrowdown' ? rows[index + 1] : rows[index - 1]
    if (!next && row) return
    event.preventDefault()
    const target_ = next ?? rows[0]
    target_.focus()
    target_.scrollIntoView({ block: 'nearest' })
    return
  }
  if (!row || target !== row) return
  const action = key === 'c' ? 'confirm' : key === 'x' ? 'reject' : key === 'o' ? 'classify' : key === 'enter' ? 'inspect' : null
  if (!action) return
  const button = row.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)
  if (!button || button.disabled) return
  event.preventDefault()
  button.click()
}

function eventText(event: DecisionEvent): string {
  const when = new Date(event.at).toLocaleString()
  if (event.action === 'complete') return `${count(event.seq)}. Marked complete · ${when}`
  if (event.action === 'classify') {
    const what = event.classification === null ? 'Cleared the classification of' : `Classified as “${CLASSIFICATION_LABELS[event.classification]}”:`
    return `${count(event.seq)}. ${what} ${keyLabel(event.key)}${event.note ? ` — “${event.note}”` : ''} · ${when}`
  }
  const verb = { confirm: 'Confirmed', reject: 'Rejected', restore: 'Restored', unmatch: 'Unmatched' }[event.action]
  const note = event.action === 'confirm' ? ` · ${decisionNote(event)}` : ''
  return `${count(event.seq)}. ${verb} ${keyLabel(event.bank)} ↔ ${keyLabel(event.books)}${note} · ${when}`
}

const HISTORY_SHOWN = 500

// Built only while open, and only the latest entries: a long session's history would
// otherwise be redrawn on every decision. The full history is in backups and reports.
function History({ events, snapshots }: { events: DecisionEvent[]; snapshots: Map<string, TransactionSnapshot> }) {
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
  const [selection, setSelection] = useState<Selection>({})
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
  const listKey = `${summary.matchId}-${version}-${tab}-${search}-${direction}`
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
            <VirtualList<SuggestionItem>
              key={listKey}
              fetchPage={fetchPage('suggested')}
              estimateSize={170}
              empty="No open suggestions."
              label="Suggested pairs, scroll to browse"
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
            <VirtualList<ConfirmedItem>
              key={listKey}
              fetchPage={fetchPage('confirmed')}
              estimateSize={170}
              empty="Nothing confirmed yet."
              label="Confirmed matches, scroll to browse"
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
              onClear={() => setSelection({})}
            />
            <p className="note">
              Valid transactions not in a confirmed match. Classify each one that stays unmatched: completion needs them all classified. O applies
              the usual classification to the focused row.
            </p>
            <VirtualList<UnmatchedItem>
              key={listKey}
              fetchPage={fetchPage('unmatched')}
              estimateSize={110}
              empty="Every valid transaction is in a confirmed match."
              label="Unmatched transactions, scroll to browse"
              summary={filteredNote('transaction')}
              renderRow={(t) =>
                t ? (
                  <Row label={`Unmatched: ${locationText(t, formats)}`}>
                    <div className="unmatched-row">
                      <TransactionCard t={t} formats={formats} />
                      <div className="row-actions">
                        <span className="muted">{t.suggestions === 0 ? 'No open suggestion' : `In ${counted(t.suggestions, 'open suggestion')}`}</span>
                        <button
                          type="button"
                          className="secondary"
                          aria-pressed={selection[t.side]?.key === t.key}
                          onClick={() => setSelection((prev) => ({ ...prev, [t.side]: prev[t.side]?.key === t.key ? undefined : t }))}
                        >
                          {selection[t.side]?.key === t.key ? 'Selected' : 'Select for pair'}
                        </button>
                        <ClassifyControls t={t} formats={formats} busy={busy} onDecide={onDecide} />
                        <DetailsButton keys={[t.key]} onInspect={setInspecting} />
                      </div>
                    </div>
                  </Row>
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
            <VirtualList<RejectedItem>
              key={listKey}
              fetchPage={fetchPage('rejected')}
              estimateSize={150}
              empty="No rejected pairs."
              label="Rejected pairs, scroll to browse"
              summary={filteredNote('pair')}
              renderRow={(item) => (item ? <RejectedRow item={item} formats={formats} busy={busy} onDecide={onDecide} onInspect={setInspecting} /> : placeholder)}
            />
          </>
        )}
        {tab === 'problems' && (
          <>
            <p className="note">Rows that cannot be matched: invalid dates or amounts, and zero amounts kept out of matching. Counts are source rows.</p>
            <VirtualList<ProblemItem>
              key={listKey}
              fetchPage={fetchPage('problems')}
              estimateSize={90}
              empty="No problems."
              label="Problem rows, scroll to browse"
              summary={(total) => (search ? `${counted(total, 'row')} shown for this search.` : null)}
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
