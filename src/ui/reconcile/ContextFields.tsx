import type { SessionContext } from '../../reconciliation/types'
import { NumberField } from './NumberField'

export function ContextFields({ context, issues, onChange }: { context: SessionContext; issues: string[]; onChange: (context: SessionContext) => void }) {
  return (
    <fieldset className="panel session-fields">
      <legend>Account</legend>
      <label className="field">
        <span>Account name</span>
        <input type="text" value={context.account} onChange={(e) => onChange({ ...context, account: e.target.value })} />
      </label>
      <label className="field">
        <span>Currency</span>
        <input type="text" value={context.currency} placeholder="INR" onChange={(e) => onChange({ ...context, currency: e.target.value.toUpperCase() })} />
      </label>
      <NumberField label="Decimal places" value={context.minorUnits} min={0} max={4} onCommit={(minorUnits) => onChange({ ...context, minorUnits })} />
      <p className="note">
        You state these; the files are not checked against them. Both files must be for this one account and currency.
      </p>
      {issues.length > 0 && (
        <ul className="mapping-issues">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
    </fieldset>
  )
}
