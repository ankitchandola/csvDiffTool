import { describe, expect, it } from 'vitest'
import { type Decimal, parseDecimal, withinTolerance } from './decimal'

function d(text: string): Decimal {
  const value = parseDecimal(text, false)
  if (!value) throw new Error(`not a decimal: ${text}`)
  return value
}

describe('parseDecimal', () => {
  it.each([
    ['1.5', 15n, 1],
    ['-0.25', -25n, 2],
    ['+7', 7n, 0],
    ['.5', 5n, 1],
    ['3.', 3n, 0],
  ])('parses %s', (text, units, scale) => {
    expect(parseDecimal(text, false)).toEqual({ units, scale })
  })

  it.each(['N/A', '', ' 1', '1e5', '1.2.3', '1,200'])('rejects %j', (text) => {
    expect(parseDecimal(text, false)).toBeNull()
  })

  it('strips well-formed thousands separators only when asked', () => {
    expect(parseDecimal('1,200.50', true)).toEqual({ units: 120050n, scale: 2 })
    expect(parseDecimal('1,2', true)).toBeNull()
    expect(parseDecimal('12,00', true)).toBeNull()
  })
})

describe('withinTolerance', () => {
  it('treats 1.5 and 1.50 as equal at zero tolerance', () => {
    expect(withinTolerance(d('1.5'), d('1.50'), d('0'))).toBe(true)
  })

  it('includes the tolerance boundary exactly', () => {
    expect(withinTolerance(d('1.00'), d('1.01'), d('0.01'))).toBe(true)
    expect(withinTolerance(d('1.00'), d('1.02'), d('0.01'))).toBe(false)
    expect(withinTolerance(d('1.01'), d('1.00'), d('0.01'))).toBe(true)
  })
})
