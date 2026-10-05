import type { FieldChange, Row, Side } from './types'
import { type CompiledValueRules, compareValues } from './values'

export interface RecordComparison {
  changes: FieldChange[]
  unparseable: { column: string; side: Side }[]
}

export function compareRecords(
  oldRow: Row,
  newRow: Row,
  columns: string[],
  rules: CompiledValueRules,
): RecordComparison {
  const changes: FieldChange[] = []
  const unparseable: RecordComparison['unparseable'] = []
  for (const column of columns) {
    const before = oldRow[column]
    const after = newRow[column]
    const verdict = compareValues(column, before, after, rules)
    if (!verdict.equal) changes.push({ column, before, after })
    for (const side of verdict.unparseable) unparseable.push({ column, side })
  }
  return { changes, unparseable }
}
