import { DATE_FORMATS, type DateFormat } from '../../reconciliation/dates'
import type { DateKind, Direction } from '../../reconciliation/types'
import { Select } from '../Select'
import type { MappingDraft } from './mapping-draft'

const NONE = { value: '', label: 'None' }

function ColumnSelect({
  label,
  visibleLabel,
  headers,
  value,
  optional = false,
  onChange,
}: {
  label: string
  visibleLabel: string
  headers: string[]
  value: string
  optional?: boolean
  onChange: (column: string) => void
}) {
  return (
    <div className="field">
      <span>{visibleLabel}</span>
      <Select
        label={label}
        value={value}
        onChange={onChange}
        options={[optional ? NONE : { value: '', label: 'Choose a column' }, ...headers.map((h) => ({ value: h, label: h }))]}
      />
    </div>
  )
}

export function MappingForm({
  title,
  headers,
  draft,
  issues,
  onChange,
}: {
  title: string
  headers: string[]
  draft: MappingDraft
  issues: string[]
  onChange: (draft: MappingDraft) => void
}) {
  const set = <K extends keyof MappingDraft>(key: K, value: MappingDraft[K]) => onChange({ ...draft, [key]: value })
  const name = title.toLowerCase().split(' ').filter(Boolean).join('-')
  return (
    <fieldset className="panel mapping-form">
      <legend>{title}</legend>
      <ColumnSelect label={`${title} date column`}
        visibleLabel="Date column" headers={headers} value={draft.dateColumn} onChange={(v) => set('dateColumn', v)} />
      <div className="field">
        <span>Date format</span>
        <Select<DateFormat | ''>
          label={`${title} date format`}
          value={draft.dateFormat}
          onChange={(v) => set('dateFormat', v)}
          options={[{ value: '', label: 'Choose a format' }, ...DATE_FORMATS.map((f) => ({ value: f, label: f }))]}
        />
      </div>
      <div className="field">
        <span>The date is the</span>
        <Select<DateKind>
          label={`${title} date kind`}
          value={draft.dateKind}
          onChange={(v) => set('dateKind', v)}
          options={[
            { value: 'posting', label: 'Posting date' },
            { value: 'value', label: 'Value date' },
            { value: 'transaction', label: 'Transaction date' },
          ]}
        />
      </div>

      <div className="field" role="radiogroup" aria-label={`${title} amount layout`}>
        <span>Amounts</span>
        <label className="choice">
          <input type="radio" name={`${name}-amount`} checked={draft.amountKind === 'signed'} onChange={() => set('amountKind', 'signed')} /> One signed
          column
        </label>
        <label className="choice">
          <input type="radio" name={`${name}-amount`} checked={draft.amountKind === 'split'} onChange={() => set('amountKind', 'split')} /> Separate
          money-in and money-out columns
        </label>
      </div>
      {draft.amountKind === 'signed' ? (
        <>
          <ColumnSelect label={`${title} amount column`}
        visibleLabel="Amount column" headers={headers} value={draft.amountColumn} onChange={(v) => set('amountColumn', v)} />
          <div className="field">
            <span>Positive amounts are</span>
            <Select<Direction>
              label={`${title} positive amounts are`}
              value={draft.positiveIs}
              onChange={(v) => set('positiveIs', v)}
              options={[
                { value: 'in', label: 'Money in' },
                { value: 'out', label: 'Money out' },
              ]}
            />
          </div>
        </>
      ) : (
        <>
          <ColumnSelect label={`${title} money-in column`}
        visibleLabel="Money-in column" headers={headers} value={draft.inColumn} onChange={(v) => set('inColumn', v)} />
          <ColumnSelect label={`${title} money-out column`}
        visibleLabel="Money-out column" headers={headers} value={draft.outColumn} onChange={(v) => set('outColumn', v)} />
          <p className="note">A bank statement's “Credit” column is usually money in; a books cash account's credit is money out.</p>
          <div className="field">
            <span>The unused column holds</span>
            <Select<MappingDraft['unused']>
              label={`${title} unused column holds`}
              value={draft.unused}
              onChange={(v) => set('unused', v)}
              options={[
                { value: 'blank', label: 'Nothing (blank)' },
                { value: 'blank-or-zero', label: 'Nothing or zero' },
              ]}
            />
          </div>
        </>
      )}
      <label className="choice">
        <input type="checkbox" checked={draft.grouped} onChange={(e) => set('grouped', e.target.checked)} /> Amounts use thousands separators
        (1,234.50 or 1,23,456.00)
      </label>
      <label className="choice">
        <input type="checkbox" checked={draft.trailingMinus} onChange={(e) => set('trailingMinus', e.target.checked)} /> Negatives may end in a
        minus (500.00-)
      </label>
      <label className="choice">
        <input type="checkbox" checked={draft.parentheses} onChange={(e) => set('parentheses', e.target.checked)} /> Negatives may be in
        brackets ((500.00))
      </label>

      <ColumnSelect label={`${title} reference column`}
        visibleLabel="Reference column (optional)" headers={headers} value={draft.reference} optional onChange={(v) => set('reference', v)} />
      <ColumnSelect
        label={`${title} description column`}
        visibleLabel="Description column (optional)"
        headers={headers}
        value={draft.description}
        optional
        onChange={(v) => set('description', v)}
      />
      <ColumnSelect
        label={`${title} running balance column`}
        visibleLabel="Running balance column (optional)"
        headers={headers}
        value={draft.balance}
        optional
        onChange={(v) => set('balance', v)}
      />
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
