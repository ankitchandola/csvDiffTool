import { describe, expect, it } from 'vitest'
import { comparisonLine, ruleDetails, valueRulesLine } from './rules-summary'

const exact = { ignoredColumns: [], trim: false, caseInsensitive: [], numeric: {} }
const custom = {
  ignoredColumns: ['updated_at', 'note'],
  trim: true,
  caseInsensitive: ['city'],
  numeric: { price: { tolerance: '0.01', stripThousandsSeparator: true } },
}

describe('rule summaries', () => {
  it('says exact comparison when no value rule is set', () => {
    expect(valueRulesLine(exact)).toBe('Exact comparison')
  })

  it('compresses rules into one line', () => {
    expect(comparisonLine({ columns: ['warehouse', 'sku'], trim: true, caseInsensitive: false }, custom)).toBe(
      'Key: warehouse + sku (trimmed) · trim values · 2 ignored columns · case ignored in 1 column · 1 numeric column',
    )
  })

  it('spells every rule out for the details', () => {
    expect(ruleDetails({ columns: ['id'], trim: false, caseInsensitive: true }, custom)).toEqual([
      'Records are matched on id, ignoring case.',
      'Values ignore surrounding spaces.',
      'Not compared: updated_at, note.',
      'Case ignored in: city.',
      'Compared as numbers: price (within 0.01, thousands separators read).',
    ])
  })
})
