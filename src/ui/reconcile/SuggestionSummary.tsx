import { RECON_SIDES, type SessionContext } from '../../reconciliation/types'
import type { MatchSummary } from '../../worker/reconcile-protocol'
import { count, counted } from '../format'
import { SIDE_LABELS } from './location'

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span className="metric-label">{label}</span>
    </div>
  )
}

export function SuggestionSummary({ summary, context }: { summary: MatchSummary; context: SessionContext }) {
  return (
    <>
      <div className="results-toolbar">
        <div className="metric-grid">
          <Metric label="Candidate pairs found" value={count(summary.pairs)} />
          <Metric label="Groups" value={count(summary.groups)} />
          <Metric label="Unique groups" value={count(summary.uniqueGroups)} />
          <Metric label="Without a candidate" value={count(summary.noCandidate.bank + summary.noCandidate.books)} />
        </div>
      </div>
      <p className="key-status">
        {RECON_SIDES.map((side) => (
          <span key={side} className="side-line">
            {SIDE_LABELS[side]}: {counted(summary.withCandidates[side], 'transaction')} with candidates, {count(summary.noCandidate[side])} without,{' '}
            {count(summary.invalid[side])} invalid, {count(summary.zero[side])} zero.{' '}
          </span>
        ))}
      </p>
      {summary.incomplete && (
        <p className="warning" role="alert">
          Incomplete search: {summary.incomplete} Transactions without a candidate may have one that was not searched.
        </p>
      )}
      {summary.referenceConflicts > 0 && (
        <p className="note">
          {counted(summary.referenceConflicts, 'pair')} met the amount and date rules but had different references, so{' '}
          {summary.referenceConflicts === 1 ? 'it is' : 'they are'} not suggested.
        </p>
      )}
      <p className="note">
        Rules: exact amount and direction; bank date {counted(summary.rules.bankDaysBefore, 'day')} before to {counted(summary.rules.bankDaysAfter, 'day')} after books;{' '}
        {summary.rules.referencesShared ? `references compared${summary.rules.referenceCaseInsensitive ? ', ignoring case' : ''}` : 'references for context only'}.
        {' '}Account: {context.account || 'unnamed'}, {context.currency} (stated, not checked).
      </p>
    </>
  )
}
