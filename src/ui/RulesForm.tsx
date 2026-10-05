import type { KeyRules, ValueRules } from '../engine/types'

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
      <legend>Key columns (which records are the same entity)</legend>
      <div className="chips">
        {columns.map((column) => (
          <label key={column}>
            <input
              type="checkbox"
              checked={rules.columns.includes(column)}
              onChange={(e) => onChange({ ...rules, columns: toggle(rules.columns, column, e.target.checked) })}
            />
            {column}
          </label>
        ))}
      </div>
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
  function setNumeric(column: string, rule: ValueRules['numeric'][string] | null) {
    const numeric = { ...rules.numeric }
    if (rule) numeric[column] = rule
    else delete numeric[column]
    onChange({ ...rules, numeric })
  }

  return (
    <fieldset>
      <legend>Value rules (whether two fields count as different)</legend>
      <label>
        <input type="checkbox" checked={rules.trim} onChange={(e) => onChange({ ...rules, trim: e.target.checked })} />
        Trim spaces around values in every column
      </label>
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
              const numeric = rules.numeric[column]
              return (
                <tr key={column}>
                  <td>{column}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={ignored}
                      onChange={(e) =>
                        onChange({ ...rules, ignoredColumns: toggle(rules.ignoredColumns, column, e.target.checked) })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
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
                        value={numeric.tolerance}
                        onChange={(e) => setNumeric(column, { ...numeric, tolerance: e.target.value })}
                      />
                    )}
                  </td>
                  <td>
                    {numeric && (
                      <input
                        type="checkbox"
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
