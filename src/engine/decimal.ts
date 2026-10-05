// Exact decimal: value = units / 10^scale. Floats can't be used for tolerance
// checks because 1.01 - 1.00 === 0.010000000000000009 > 0.01.
export interface Decimal {
  units: bigint
  scale: number
}

const PLAIN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/
const GROUPED = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d*)?$/

export function parseDecimal(raw: string, stripThousandsSeparator: boolean): Decimal | null {
  const text = stripThousandsSeparator && GROUPED.test(raw) ? raw.replaceAll(',', '') : raw
  if (!PLAIN.test(text)) return null
  const negative = text.startsWith('-')
  const [intPart, fracPart = ''] = text.replace(/^[+-]/, '').split('.')
  const units = BigInt((intPart || '0') + fracPart)
  return { units: negative ? -units : units, scale: fracPart.length }
}

function atScale(d: Decimal, scale: number): bigint {
  return d.units * 10n ** BigInt(scale - d.scale)
}

export function withinTolerance(a: Decimal, b: Decimal, tolerance: Decimal): boolean {
  const scale = Math.max(a.scale, b.scale, tolerance.scale)
  const diff = atScale(a, scale) - atScale(b, scale)
  return (diff < 0n ? -diff : diff) <= atScale(tolerance, scale)
}
