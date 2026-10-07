import { AlertTriangle, ArrowLeftRight, CircleSlash, Search } from 'lucide-react'
import { useState } from 'react'
import type { Direction, MatchingRules, ReconSide } from '../../reconciliation/types'
import type { ReconcileClient } from '../../worker/client'
import type {
  MatchSummary,
  OriginalValues,
  ProblemItem,
  ReviewItems,
  ReviewTab,
  SuggestionItem,
  TransactionView,
} from '../../worker/reconcile-protocol'
import { count, counted, formatValue } from '../format'
import { VirtualList } from '../results/VirtualList'
import { Select } from '../Select'
import { useDebounced } from '../use-debounced'
import { type Formats, locationText } from './location'
import { competitionText, evidenceText } from './evidence'

function originalAmount(original: OriginalValues): string {
  return original.amount.length === 1 ? formatValue(original.amount[0]) : `in ${formatValue(original.amount[0])} · out ${formatValue(original.amount[1])}`
}

function Transaction({ t, formats }: { t: TransactionView; formats: Formats }) {
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

function SuggestionRow({ item, rules, formats }: { item: SuggestionItem; rules: MatchingRules; formats: Formats }) {
  return (
    <div className="suggestion">
      <div className="group-label">
        <span className={item.unique ? 'chip' : 'chip competing'}>Group {count(item.group + 1)}</span>
        <span className="muted">{competitionText(item)}</span>
      </div>
      <div className="pair">
        <Transaction t={item.bank} formats={formats} />
        <ArrowLeftRight size={16} aria-hidden="true" className="pair-arrow" />
        <Transaction t={item.books} formats={formats} />
      </div>
      <p className="evidence">{evidenceText(item, rules)}</p>
    </div>
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

const TABS: [ReviewTab, string, typeof Search][] = [
  ['suggested', 'Suggested', ArrowLeftRight],
  ['unmatched', 'No candidate', CircleSlash],
  ['problems', 'Problems', AlertTriangle],
]

export function ReviewView({ client, summary, formats }: { client: ReconcileClient; summary: MatchSummary; formats: Formats }) {
  const [tab, setTab] = useState<ReviewTab>('suggested')
  const [query, setQuery] = useState('')
  const [direction, setDirection] = useState<Direction | ''>('')
  const search = useDebounced(query, 250)
  const both = (r: Record<ReconSide, number>) => r.bank + r.books
  const totals: Record<ReviewTab, number> = {
    suggested: summary.pairs,
    unmatched: both(summary.noCandidate),
    problems: both(summary.invalid) + both(summary.zero),
  }
  const fetchPage = <T extends ReviewTab>(which: T) => (offset: number, limit: number) =>
    client
      .call('getReview', { matchId: summary.matchId, tab: which, offset, limit, search, ...(direction && which !== 'problems' ? { direction } : {}) })
      .then((page) => ({ total: page.total, items: page.items as ReviewItems[T][] }))
  const listKey = `${summary.matchId}-${tab}-${search}-${direction}`

  return (
    <section className="panel results-panel review-panel" aria-label="Review">
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
              const index = TABS.findIndex(([key]) => key === id)
              const next = e.key === 'ArrowRight' ? (index + 1) % TABS.length : e.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1
              if (next < 0) return
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
      <div id="recon-panel" role="tabpanel" aria-labelledby={`recon-tab-${tab}`}>
        {tab === 'suggested' && (
          <>
            <p className="note">
              Counts are candidate pairs. A transaction can appear in several pairs; pairs in the same group compete. Nothing here is
              confirmed.
            </p>
            <VirtualList<SuggestionItem>
              key={listKey}
              fetchPage={fetchPage('suggested')}
              estimateSize={150}
              empty="No suggested pairs."
              label="Suggested pairs, scroll to browse"
              summary={(total) => (search || direction ? `${counted(total, 'pair')} match.` : null)}
              renderRow={(item) => (item ? <SuggestionRow item={item} rules={summary.rules} formats={formats} /> : <div className="cell">…</div>)}
            />
          </>
        )}
        {tab === 'unmatched' && (
          <>
            <p className="note">Valid transactions with no pair under these rules. They are not outstanding items: nothing has been reviewed.</p>
            <VirtualList<TransactionView>
              key={listKey}
              fetchPage={fetchPage('unmatched')}
              estimateSize={90}
              empty="Every valid transaction has at least one candidate."
              label="Transactions without a candidate, scroll to browse"
              summary={(total) => (search || direction ? `${counted(total, 'transaction')} match.` : null)}
              renderRow={(t) => (t ? <div className="cell"><Transaction t={t} formats={formats} /></div> : <div className="cell">…</div>)}
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
              summary={(total) => (search ? `${counted(total, 'row')} match.` : null)}
              renderRow={(p) => (p ? <div className="cell"><ProblemRow item={p} formats={formats} /></div> : <div className="cell">…</div>)}
            />
          </>
        )}
      </div>
    </section>
  )
}
