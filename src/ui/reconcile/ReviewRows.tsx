import { ArrowLeftRight, CheckCircle2, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { type Classification, CLASSIFICATION_LABELS, classificationsFor, type TxnKey } from '../../reconciliation/decisions'
import type { MatchingRules } from '../../reconciliation/types'
import type { ConfirmedItem, DecisionInput, ProblemItem, RejectedItem, SuggestionItem, UnmatchedItem } from '../../worker/reconcile-protocol'
import { count, counted, formatValue } from '../format'
import { Select } from '../Select'
import { competitionText, dateEvidence, evidenceText } from './evidence'
import { type Formats, keyLabel, locationText, originalAmount } from './location'
import { decisionNote } from './review-text'
import { TransactionCard } from './TransactionCard'

// Resolves to an error message, or null once the decision is recorded.
export type Decide = (decision: DecisionInput) => Promise<string | null>

export type Inspect = (keys: TxnKey[]) => void

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

function DetailsButton({ keys, onInspect }: { keys: TxnKey[]; onInspect: Inspect }) {
  return (
    <button type="button" className="secondary" data-action="inspect" aria-keyshortcuts="Enter" onClick={() => onInspect(keys)}>
      Details
    </button>
  )
}

export function SuggestionRow({
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

export function UnmatchedRow({
  t,
  formats,
  busy,
  selected,
  onSelect,
  onDecide,
  onInspect,
}: {
  t: UnmatchedItem
  formats: Formats
  busy: boolean
  selected: boolean
  onSelect: () => void
  onDecide: Decide
  onInspect: Inspect
}) {
  return (
    <Row label={`Unmatched: ${locationText(t, formats)}`}>
      <div className="unmatched-row">
        <TransactionCard t={t} formats={formats} />
        <div className="row-actions">
          <span className="muted">{t.suggestions === 0 ? 'No open suggestion' : `In ${counted(t.suggestions, 'open suggestion')}`}</span>
          <button type="button" className="secondary" aria-pressed={selected} onClick={onSelect}>
            {selected ? 'Selected' : 'Select for pair'}
          </button>
          <ClassifyControls t={t} formats={formats} busy={busy} onDecide={onDecide} />
          <DetailsButton keys={[t.key]} onInspect={onInspect} />
        </div>
      </div>
    </Row>
  )
}

export function ConfirmedRow({ item, rules, formats, busy, onDecide, onInspect }: { item: ConfirmedItem; rules: MatchingRules; formats: Formats; busy: boolean; onDecide: Decide; onInspect: Inspect }) {
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

export function RejectedRow({ item, formats, busy, onDecide, onInspect }: { item: RejectedItem; formats: Formats; busy: boolean; onDecide: Decide; onInspect: Inspect }) {
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

export function ProblemRow({ item, formats }: { item: ProblemItem; formats: Formats }) {
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
