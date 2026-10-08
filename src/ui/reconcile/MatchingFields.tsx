import type { MatchingRules } from '../../reconciliation/types'
import { NumberField } from './NumberField'

// effective: the rules as applied, with reference comparison off unless both sides map a reference.
export function MatchingFields({
  rules,
  effective,
  referencesMapped,
  onChange,
}: {
  rules: MatchingRules
  effective: MatchingRules
  referencesMapped: boolean
  onChange: (rules: MatchingRules) => void
}) {
  return (
    <fieldset className="panel matching-fields">
      <legend>Matching</legend>
      <p className="note">Amounts must match exactly, with the same cash direction. Amount tolerance is not available yet.</p>
      <NumberField label="Bank date up to this many days before books" value={rules.bankDaysBefore} min={0} max={366} onCommit={(bankDaysBefore) => onChange({ ...rules, bankDaysBefore })} />
      <NumberField label="Bank date up to this many days after books" value={rules.bankDaysAfter} min={0} max={366} onCommit={(bankDaysAfter) => onChange({ ...rules, bankDaysAfter })} />
      <label className="choice">
        <input
          type="checkbox"
          checked={effective.referencesShared}
          disabled={!referencesMapped}
          onChange={(e) => onChange({ ...rules, referencesShared: e.target.checked })}
        />{' '}
        Both reference columns hold the same identifier (for example a cheque number)
      </label>
      <label className="choice">
        <input
          type="checkbox"
          checked={effective.referenceCaseInsensitive}
          disabled={!effective.referencesShared}
          onChange={(e) => onChange({ ...rules, referenceCaseInsensitive: e.target.checked })}
        />{' '}
        Ignore case when comparing references
      </label>
      <p className="note">
        When references are compared, matching ones are listed first and differing ones are not suggested. Otherwise references are shown
        for context only.
      </p>
    </fieldset>
  )
}
