import { describe, expect, it } from 'vitest'
import { addDecimal, compareDecimal, type Decimal, formatDecimal, isPlainDecimal, negateDecimal, parseDecimal, subtractDecimal, toScale, withinTolerance } from './decimal'

function d(text: string): Decimal {
  const value = parseDecimal(text)
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
    expect(parseDecimal(text)).toEqual({ units, scale })
  })

  it.each(['N/A', '', ' 1', '1e5', '1.2.3', '1,200', '5-'])('rejects %j by default', (text) => {
    expect(parseDecimal(text)).toBeNull()
  })

  it('strips well-formed thousands separators only when asked', () => {
    expect(parseDecimal('1,200.50', { grouped: true })).toEqual({ units: 120050n, scale: 2 })
    expect(parseDecimal('1,2', { grouped: true })).toBeNull()
    expect(parseDecimal('12,00', { grouped: true })).toBeNull()
  })

  it.each([
    ['1,23,456.00', 12345600n, 2],
    ['12,34,567', 1234567n, 0],
    ['1,00,00,000', 10000000n, 0],
    ['-1,23,456', -123456n, 0],
  ])('accepts Indian grouping %s', (text, units, scale) => {
    expect(parseDecimal(text, { grouped: true })).toEqual({ units, scale })
  })

  it.each(['1,23,4567', '1,2,345', '123,45,678', '1,23,45'])('rejects malformed grouping %j', (text) => {
    expect(parseDecimal(text, { grouped: true })).toBeNull()
  })

  it.each([
    ['1234.50-', -123450n, 2],
    ['5-', -5n, 0],
    ['.5-', -5n, 1],
  ])('reads trailing minus %s as negative when asked', (text, units, scale) => {
    expect(parseDecimal(text, { trailingMinus: true })).toEqual({ units, scale })
  })

  it.each(['₹1,234.50', '$1,234.50', '12%', '1,234.50 USD'])('leaves display-only formats such as %j to text comparison', (text) => {
    expect(parseDecimal(text, { grouped: true, trailingMinus: true })).toBeNull()
  })

  it('combines Indian grouping with a trailing minus', () => {
    expect(parseDecimal('1,23,456.00-', { grouped: true, trailingMinus: true })).toEqual({ units: -12345600n, scale: 2 })
  })

  it.each(['-5-', '+5-', '-', '5--', '5 -'])('rejects a malformed trailing minus %j', (text) => {
    expect(parseDecimal(text, { grouped: true, trailingMinus: true })).toBeNull()
  })
})

describe('isPlainDecimal', () => {
  it.each(['-12', '+3.5', '-0.25', '.5', '3.', '0'])('accepts %j', (text) => {
    expect(isPlainDecimal(text)).toBe(true)
  })

  it.each(['', '.', '-', '+.', '1,234', '1234.50-', '1e5', '1.2.3', '-1+1', ' 1'])('rejects %j', (text) => {
    expect(isPlainDecimal(text)).toBe(false)
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

describe('decimal arithmetic', () => {
  it('adds and subtracts across scales exactly', () => {
    expect(addDecimal(d('0.1'), d('0.2'))).toEqual(d('0.3'))
    expect(subtractDecimal(d('1.01'), d('1'))).toEqual({ units: 1n, scale: 2 })
    expect(subtractDecimal(d('5'), d('7.25'))).toEqual(d('-2.25'))
  })

  it('compares values with different scales', () => {
    expect(compareDecimal(d('1.5'), d('1.50'))).toBe(0)
    expect(compareDecimal(d('-1'), d('0.01'))).toBe(-1)
    expect(compareDecimal(d('10'), d('9.999'))).toBe(1)
  })

  it('negates', () => {
    expect(negateDecimal(d('-3.5'))).toEqual(d('3.5'))
  })

  it('rescales only when no digits are lost', () => {
    expect(toScale(d('1.5'), 2)).toEqual({ units: 150n, scale: 2 })
    expect(toScale(d('1.500'), 2)).toEqual({ units: 150n, scale: 2 })
    expect(toScale(d('1.505'), 2)).toBeNull()
    expect(toScale(d('-12.30'), 0)).toBeNull()
    expect(toScale(d('-12.00'), 0)).toEqual({ units: -12n, scale: 0 })
  })

  it.each([
    ['0', '0'],
    ['0.05', '0.05'],
    ['-0.05', '-0.05'],
    ['1234.50', '1234.50'],
    ['-7', '-7'],
    ['.5', '0.5'],
  ])('formats %s as %s', (text, expected) => {
    expect(formatDecimal(d(text))).toBe(expected)
  })
})
