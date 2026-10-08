import { useState } from 'react'
import type { BalanceBasis } from '../../reconciliation/accounting'
import type { AccountingSetup, StatedBalances } from '../../reconciliation/session'
import { RECON_SIDES } from '../../reconciliation/types'
import { Select } from '../Select'
import { SIDE_LABELS } from './location'

export function AccountingFields({ setup, onChange }: { setup: AccountingSetup; onChange: (setup: AccountingSetup) => void }) {
  const setBalance = (side: 'bank' | 'books', change: Partial<StatedBalances>) =>
    onChange({ ...setup, balances: { ...setup.balances, [side]: { ...setup.balances[side], ...change } } })
  // The dates as typed, which may be half-entered. The setup gets a period only once both
  // are entered and in order, so a saved session never holds an incomplete one.
  const [draft, setDraft] = useState({ start: setup.period?.start ?? '', end: setup.period?.end ?? '' })
  const [shown, setShown] = useState(setup.period)
  if (shown !== setup.period) {
    setShown(setup.period)
    if (setup.period) setDraft(setup.period)
  }
  const setPeriod = (field: 'start' | 'end', value: string) => {
    const next = { ...draft, [field]: value }
    setDraft(next)
    const complete = next.start !== '' && next.end !== '' && next.start <= next.end
    const period = complete ? next : null
    setShown(period)
    onChange({ ...setup, period })
  }
  const periodNote =
    draft.start === '' && draft.end === ''
      ? null
      : draft.start === '' || draft.end === ''
        ? 'Enter both the start and the end of the period.'
        : draft.start > draft.end
          ? 'The period ends before it starts.'
          : null
  return (
    <fieldset className="panel accounting-fields">
      <legend>Period and balances</legend>
      <p className="note">
        Optional for matching. Needed before the balance checks and completion can be earned. Type balances exactly as the statement and
        the ledger show them; a liability-basis side (such as a credit card) is converted to cash terms.
      </p>
      <div className="period-fields">
        <label className="field">
          <span>Period start</span>
          <input type="date" value={draft.start} onChange={(e) => setPeriod('start', e.target.value)} />
        </label>
        <label className="field">
          <span>Period end</span>
          <input type="date" value={draft.end} onChange={(e) => setPeriod('end', e.target.value)} />
        </label>
      </div>
      {periodNote && (
        <p className="warning" role="status">
          {periodNote}
        </p>
      )}
      <div className="balance-grid">
        {RECON_SIDES.map((side) => (
          <div key={side} className="balance-side">
            <h3>{SIDE_LABELS[side]}</h3>
            <label className="field">
              <span>Opening balance</span>
              <input
                type="text"
                inputMode="decimal"
                aria-label={`${SIDE_LABELS[side]} opening balance`}
                value={setup.balances[side].opening ?? ''}
                onChange={(e) => setBalance(side, { opening: e.target.value === '' ? null : e.target.value })}
              />
            </label>
            <label className="field">
              <span>Closing balance</span>
              <input
                type="text"
                inputMode="decimal"
                aria-label={`${SIDE_LABELS[side]} closing balance`}
                value={setup.balances[side].closing ?? ''}
                onChange={(e) => setBalance(side, { closing: e.target.value === '' ? null : e.target.value })}
              />
            </label>
            <div className="field">
              <span>Balances are</span>
              <Select<BalanceBasis>
                label={`${SIDE_LABELS[side]} balance basis`}
                value={setup.balances[side].basis}
                onChange={(basis) => setBalance(side, { basis })}
                options={[
                  { value: 'cash', label: 'Money held (positive is in credit)' },
                  { value: 'liability', label: 'Amount owed (a credit card or loan)' },
                ]}
              />
            </div>
          </div>
        ))}
      </div>
    </fieldset>
  )
}
