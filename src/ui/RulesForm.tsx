import { ownValue } from '../engine/dict'
import type { KeyRules, NumericRule, ValueRules } from '../engine/types'

function toggle(list: string[], item: string, on: boolean): string[] {
  return on ? [...list, item] : list.filter((x) => x !== item)
}

export function KeyRulesForm({
  columns,
  rules,
  onChange,
}: {
  columns: string[]
  rules: KeyRules
  onChange: (rules: KeyRules) => void
}) {
  return (
    <fieldset>
      <legend>Key columns</legend>
      <p className="note">Select one unique column, or combine several.</p>
      <div className="chips">
        {columns.map((column) => (
          <label key={column} className={rules.columns.includes(column) ? 'key-chip selected' : 'key-chip'}>
            <input
              type="checkbox"
              checked={rules.columns.includes(column)}
              onChange={(e) => onChange({ ...rules, columns: toggle(rules.columns, column, e.target.checked) })}
            />
            {column}
          </label>
        ))}
      </div>
      <details className="key-options">
        <summary>
          Key options
          <span className="muted">
            {rules.trim ? 'Trim spaces' : 'Keep spaces'}{rules.caseInsensitive ? ', ignore case' : ''}
          </span>
        </summary>
        <label>
          <input type="checkbox" checked={rules.trim} onChange={(e) => onChange({ ...rules, trim: e.target.checked })} />
          Trim spaces around key values
        </label>
        <label>
          <input
            type="checkbox"
            checked={rules.caseInsensitive}
            onChange={(e) => onChange({ ...rules, caseInsensitive: e.target.checked })}
          />
          Match keys case-insensitively
        </label>
      </details>
    </fieldset>
  )
}

export function ValueRulesForm({
  columns,
  rules,
  onChange,
}: {
  columns: string[]
  rules: ValueRules
  onChange: (rules: ValueRules) => void
}) {
  function setNumeric(column: string, rule: NumericRule | null) {
    // fromEntries defines own properties, so a column named "__proto__" stays an ordinary key.
    const others = Object.entries(rules.numeric).filter(([c]) => c !== column)
    onChange({ ...rules, numeric: Object.fromEntries(rule ? [...others, [column, rule]] : others) })
  }

  return (
    <fieldset>
      <legend>Field comparison rules</legend>
      <label>
        <input type="checkbox" checked={rules.trim} onChange={(e) => onChange({ ...rules, trim: e.target.checked })} />
        Trim spaces around values in every column
      </label>
      <details className="numeric-help">
        <summary>Numeric formats</summary>
        <p className="note">
          Numeric columns accept plain decimals such as 1234.5, -0.25 or .5, and trailing-minus negatives such as
          1234.50-. With thousands separators stripped, comma grouping is accepted in Western (1,234,567.5) or Indian
          (12,34,567.5) style. Decimal commas, exponents (1e5) and surrounding spaces are not numbers; those values are compared as
          text and reported as warnings. Turn on trimming to ignore surrounding spaces.
        </p>
      </details>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Column</th>
              <th>Ignore</th>
              <th>Ignore case</th>
              <th>Numeric</th>
              <th>Tolerance</th>
              <th>Strip thousands separator</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((column) => {
              const ignored = rules.ignoredColumns.includes(column)
              const numeric = ownValue(rules.numeric, column)
              return (
                <tr key={column}>
                  <td>{column}</td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Ignore ${column}`}
                      checked={ignored}
                      onChange={(e) =>
                        onChange({ ...rules, ignoredColumns: toggle(rules.ignoredColumns, column, e.target.checked) })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Ignore case for ${column}`}
                      disabled={ignored || !!numeric}
                      checked={rules.caseInsensitive.includes(column)}
                      onChange={(e) =>
                        onChange({ ...rules, caseInsensitive: toggle(rules.caseInsensitive, column, e.target.checked) })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Compare ${column} numerically`}
                      disabled={ignored}
                      checked={!!numeric}
                      onChange={(e) =>
                        setNumeric(column, e.target.checked ? { tolerance: '0', stripThousandsSeparator: false } : null)
                      }
                    />
                  </td>
                  <td>
                    {numeric && (
                      <input
                        type="text"
                        inputMode="decimal"
                        size={8}
                        aria-label={`Tolerance for ${column}`}
                        disabled={ignored}
                        value={numeric.tolerance}
                        onChange={(e) => setNumeric(column, { ...numeric, tolerance: e.target.value })}
                      />
                    )}
                  </td>
                  <td>
                    {numeric && (
                      <input
                        type="checkbox"
                        aria-label={`Strip thousands separators for ${column}`}
                        disabled={ignored}
                        checked={numeric.stripThousandsSeparator}
                        onChange={(e) => setNumeric(column, { ...numeric, stripThousandsSeparator: e.target.checked })}
                      />
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </fieldset>
  )
}
