import type { BalanceBasis } from '../../reconciliation/accounting'
import type { AccountingSetup, StatedBalances } from '../../reconciliation/session'
import { RECON_SIDES } from '../../reconciliation/types'
import { Select } from '../Select'
import { SIDE_LABELS } from './location'

export function AccountingFields({ setup, onChange }: { setup: AccountingSetup; onChange: (setup: AccountingSetup) => void }) {
  const setBalance = (side: 'bank' | 'books', change: Partial<StatedBalances>) =>
    onChange({ ...setup, balances: { ...setup.balances, [side]: { ...setup.balances[side], ...change } } })
  const setPeriod = (field: 'start' | 'end', value: string) => {
    const period = { start: setup.period?.start ?? '', end: setup.period?.end ?? '', [field]: value }
    onChange({ ...setup, period: period.start === '' && period.end === '' ? null : period })
  }
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
          <input type="date" value={setup.period?.start ?? ''} onChange={(e) => setPeriod('start', e.target.value)} />
        </label>
        <label className="field">
          <span>Period end</span>
          <input type="date" value={setup.period?.end ?? ''} onChange={(e) => setPeriod('end', e.target.value)} />
        </label>
      </div>
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
