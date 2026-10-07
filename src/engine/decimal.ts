// Exact decimal: value = units / 10^scale. Floats can't be used for tolerance
// checks because 1.01 - 1.00 === 0.010000000000000009 > 0.01.
export interface Decimal {
  units: bigint
  scale: number
}

export interface DecimalFormat {
  // Comma grouping in the whole part: Western (1,234,567) or Indian lakh/crore (12,34,567).
  grouped?: boolean
  // Accounting/ERP exports (SAP among them) write negatives as 1234.50-.
  trailingMinus?: boolean
  // Accounting statements write negatives as (1,234.50). The brackets must hold the
  // whole value, with no sign of its own inside or after them.
  parentheses?: boolean
}

interface Signed {
  negative: boolean
  body: string
}

interface Parts {
  whole: string
  fraction: string
}

function isDigits(text: string): boolean {
  if (text.length === 0) return false
  for (const ch of text) if (ch < '0' || ch > '9') return false
  return true
}

function readSign(raw: string, trailingMinus: boolean): Signed {
  if (raw.startsWith('+') || raw.startsWith('-')) return { negative: raw.startsWith('-'), body: raw.slice(1) }
  if (trailingMinus && raw.endsWith('-')) return { negative: true, body: raw.slice(0, -1) }
  return { negative: false, body: raw }
}

function splitAtPoint(body: string): Parts {
  const point = body.indexOf('.')
  return point === -1 ? { whole: body, fraction: '' } : { whole: body.slice(0, point), fraction: body.slice(point + 1) }
}

// At least one digit overall: 3. and .5 are numbers, a lone point is not.
function plainParts({ whole, fraction }: Parts): boolean {
  if (whole === '' && fraction === '') return false
  return (whole === '' || isDigits(whole)) && (fraction === '' || isDigits(fraction))
}

function ungroup(whole: string): string | null {
  const groups = whole.split(',')
  if (!groups.every(isDigits)) return null
  const [first, ...rest] = groups
  const middle = rest.slice(0, -1)
  const last = rest[rest.length - 1]
  const western = first.length <= 3 && rest.every((g) => g.length === 3)
  const indian = first.length <= 2 && last.length === 3 && middle.every((g) => g.length === 2)
  return western || indian ? groups.join('') : null
}

// An optional leading sign and digits with at most one point: 1234.5, -0.25, +7, .5, 3.
// No grouping, no trailing minus. Formula protection relies on exactly this set.
export function isPlainDecimal(text: string): boolean {
  return plainParts(splitAtPoint(readSign(text, false).body))
}

export function parseDecimal(raw: string, { grouped = false, trailingMinus = false, parentheses = false }: DecimalFormat = {}): Decimal | null {
  if (parentheses && raw.startsWith('(')) {
    if (!raw.endsWith(')')) return null
    const inner = raw.slice(1, -1)
    if (/^[+-]|-$/.test(inner)) return null
    const value = parseDecimal(inner, { grouped })
    return value && { units: -value.units, scale: value.scale }
  }
  const { negative, body } = readSign(raw, trailingMinus)
  const parts = splitAtPoint(body)
  if (grouped && parts.whole.includes(',')) {
    const whole = ungroup(parts.whole)
    if (whole === null) return null
    parts.whole = whole
  }
  if (!plainParts(parts)) return null
  const units = BigInt((parts.whole || '0') + parts.fraction)
  return { units: negative ? -units : units, scale: parts.fraction.length }
}

function atScale(d: Decimal, scale: number): bigint {
  return d.units * 10n ** BigInt(scale - d.scale)
}

export function withinTolerance(a: Decimal, b: Decimal, tolerance: Decimal): boolean {
  const scale = Math.max(a.scale, b.scale, tolerance.scale)
  const diff = atScale(a, scale) - atScale(b, scale)
  return (diff < 0n ? -diff : diff) <= atScale(tolerance, scale)
}

function aligned(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale)
  return [atScale(a, scale), atScale(b, scale), scale]
}

export function addDecimal(a: Decimal, b: Decimal): Decimal {
  const [x, y, scale] = aligned(a, b)
  return { units: x + y, scale }
}

export function subtractDecimal(a: Decimal, b: Decimal): Decimal {
  const [x, y, scale] = aligned(a, b)
  return { units: x - y, scale }
}

export function negateDecimal(d: Decimal): Decimal {
  return { units: -d.units, scale: d.scale }
}

export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const [x, y] = aligned(a, b)
  return x < y ? -1 : x > y ? 1 : 0
}

// Exact rescale: null when the value has nonzero digits beyond the target scale.
export function toScale(d: Decimal, scale: number): Decimal | null {
  if (scale >= d.scale) return { units: atScale(d, scale), scale }
  const divisor = 10n ** BigInt(d.scale - scale)
  return d.units % divisor === 0n ? { units: d.units / divisor, scale } : null
}

export function formatDecimal({ units, scale }: Decimal): string {
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, '0')
  const whole = digits.slice(0, digits.length - scale)
  const body = scale === 0 ? whole : `${whole}.${digits.slice(-scale)}`
  return units < 0n ? `-${body}` : body
}
