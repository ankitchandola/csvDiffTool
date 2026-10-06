// Exact decimal: value = units / 10^scale. Floats can't be used for tolerance
// checks because 1.01 - 1.00 === 0.010000000000000009 > 0.01.
export interface Decimal {
  units: bigint
  scale: number
}

const PLAIN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/
// Western thousands (1,234,567) or Indian lakh/crore grouping (12,34,567).
const GROUPED = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3})(?:\.\d*)?$/

export interface DecimalFormat {
  grouped?: boolean
  // Accounting/ERP exports (SAP among them) write negatives as 1234.50-.
  trailingMinus?: boolean
}

export function parseDecimal(raw: string, { grouped = false, trailingMinus = false }: DecimalFormat = {}): Decimal | null {
  const signed = trailingMinus && raw.endsWith('-') && !/^[+-]/.test(raw) ? `-${raw.slice(0, -1)}` : raw
  const text = grouped && GROUPED.test(signed) ? signed.replaceAll(',', '') : signed
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
