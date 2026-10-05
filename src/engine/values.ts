import { type Decimal, parseDecimal, withinTolerance } from './decimal'
import type { Side, ValueRules } from './types'

export interface CompiledValueRules {
  ignored: Set<string>
  trim: boolean
  caseInsensitive: Set<string>
  numeric: Map<string, { tolerance: Decimal; stripThousandsSeparator: boolean }>
}

export interface ValueVerdict {
  equal: boolean
  unparseable: Side[]
}

export class RulesError extends Error {}

export function compileValueRules(rules: ValueRules): CompiledValueRules {
  const numeric: CompiledValueRules['numeric'] = new Map()
  const ignored = new Set(rules.ignoredColumns)
  for (const [column, rule] of Object.entries(rules.numeric)) {
    if (ignored.has(column)) continue
    const tolerance = parseDecimal(rule.tolerance.trim(), false)
    if (tolerance === null || tolerance.units < 0n) {
      throw new RulesError(`Tolerance for "${column}" must be a non-negative number, got "${rule.tolerance}"`)
    }
    numeric.set(column, { tolerance, stripThousandsSeparator: rule.stripThousandsSeparator })
  }
  return {
    ignored,
    trim: rules.trim,
    caseInsensitive: new Set(rules.caseInsensitive),
    numeric,
  }
}

export function compareValues(
  column: string,
  before: string,
  after: string,
  rules: CompiledValueRules,
): ValueVerdict {
  const a = rules.trim ? before.trim() : before
  const b = rules.trim ? after.trim() : after

  const numeric = rules.numeric.get(column)
  if (numeric) {
    const da = parseDecimal(a, numeric.stripThousandsSeparator)
    const db = parseDecimal(b, numeric.stripThousandsSeparator)
    if (da && db) return { equal: withinTolerance(da, db, numeric.tolerance), unparseable: [] }
    const unparseable: Side[] = []
    if (!da) unparseable.push('old')
    if (!db) unparseable.push('new')
    // Never coerce to zero: fall back to comparing the text as-is.
    return { equal: a === b, unparseable }
  }

  if (rules.caseInsensitive.has(column)) {
    return { equal: a.toLowerCase() === b.toLowerCase(), unparseable: [] }
  }
  return { equal: a === b, unparseable: [] }
}
