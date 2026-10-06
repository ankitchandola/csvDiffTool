import type { KeyRules, NumericRule, ValueRules } from '../engine/types'
import { counted } from './format'

function keyQualifiers(key: KeyRules): string[] {
  return [key.trim ? 'trimmed' : '', key.caseInsensitive ? 'case ignored' : ''].filter(Boolean)
}

// "Exact comparison" or "trim values · 2 ignored columns · 1 numeric column".
export function valueRulesLine(value: ValueRules): string {
  const parts = [
    value.trim ? 'trim values' : '',
    value.ignoredColumns.length > 0 ? counted(value.ignoredColumns.length, 'ignored column') : '',
    value.caseInsensitive.length > 0 ? `case ignored in ${counted(value.caseInsensitive.length, 'column')}` : '',
    Object.keys(value.numeric).length > 0 ? counted(Object.keys(value.numeric).length, 'numeric column') : '',
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : 'Exact comparison'
}

// One line for the whole comparison: "Key: warehouse + sku (trimmed) · 1 numeric column".
export function comparisonLine(key: KeyRules, value: ValueRules): string {
  const qualifiers = keyQualifiers(key)
  const keyText = `Key: ${key.columns.join(' + ')}${qualifiers.length > 0 ? ` (${qualifiers.join(', ')})` : ''}`
  return `${keyText} · ${valueRulesLine(value)}`
}

function numericText(column: string, rule: NumericRule): string {
  const tolerance = rule.tolerance.trim() === '0' ? 'exact' : `within ${rule.tolerance.trim()}`
  return `${column} (${tolerance}${rule.stripThousandsSeparator ? ', thousands separators read' : ''})`
}

// Every rule in words, one line each, for the expanded view.
export function ruleDetails(key: KeyRules, value: ValueRules): string[] {
  const numeric = Object.entries(value.numeric)
  return [
    `Records are matched on ${key.columns.join(' + ')}${key.trim ? ', ignoring surrounding spaces' : ''}${key.caseInsensitive ? ', ignoring case' : ''}.`,
    value.trim ? 'Values ignore surrounding spaces.' : 'Values must match exactly, spaces included.',
    value.ignoredColumns.length > 0 ? `Not compared: ${value.ignoredColumns.join(', ')}.` : '',
    value.caseInsensitive.length > 0 ? `Case ignored in: ${value.caseInsensitive.join(', ')}.` : '',
    numeric.length > 0 ? `Compared as numbers: ${numeric.map(([column, rule]) => numericText(column, rule)).join('; ')}.` : '',
  ].filter(Boolean)
}
