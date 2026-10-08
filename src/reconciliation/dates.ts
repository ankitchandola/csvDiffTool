export const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'DD-MM-YYYY', 'DD.MM.YYYY', 'MM/DD/YYYY', 'MM-DD-YYYY', 'DD-Mon-YYYY', 'DD Mon YYYY', 'DD/MM/YY', 'DD-MM-YY', 'DD-Mon-YY', 'MM/DD/YY'] as const

export type DateFormat = (typeof DATE_FORMATS)[number]

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

type Order = 'ymd' | 'dmy' | 'mdy'

interface Pattern {
  order: Order
  separator: string
  namedMonth?: boolean
  // Two-digit years, read as 2000 to 2099.
  shortYear?: boolean
}

const PATTERNS: Record<DateFormat, Pattern> = {
  'YYYY-MM-DD': { order: 'ymd', separator: '-' },
  'DD/MM/YYYY': { order: 'dmy', separator: '/' },
  'DD-MM-YYYY': { order: 'dmy', separator: '-' },
  'DD.MM.YYYY': { order: 'dmy', separator: '.' },
  'MM/DD/YYYY': { order: 'mdy', separator: '/' },
  'MM-DD-YYYY': { order: 'mdy', separator: '-' },
  'DD-Mon-YYYY': { order: 'dmy', separator: '-', namedMonth: true },
  'DD Mon YYYY': { order: 'dmy', separator: ' ', namedMonth: true },
  'DD/MM/YY': { order: 'dmy', separator: '/', shortYear: true },
  'DD-MM-YY': { order: 'dmy', separator: '-', shortYear: true },
  'DD-Mon-YY': { order: 'dmy', separator: '-', namedMonth: true, shortYear: true },
  'MM/DD/YY': { order: 'mdy', separator: '/', shortYear: true },
}

// The two-digit-year format to suggest when a four-digit one meets "01/09/26".
const SHORT_YEAR_OF: Partial<Record<DateFormat, DateFormat>> = { 'DD/MM/YYYY': 'DD/MM/YY', 'DD-MM-YYYY': 'DD-MM-YY', 'DD-Mon-YYYY': 'DD-Mon-YY', 'MM/DD/YYYY': 'MM/DD/YY' }

export type DateOutcome = { ok: true; day: number } | { ok: false; message: string }

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year: number, month: number): number {
  return month === 2 ? (isLeap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31
}

// Days since 1970-01-01 in the proleptic Gregorian calendar, by integer arithmetic only:
// no Date objects, so no time zone or daylight-saving shift can move a day.
export function dayNumber(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yearOfEra = y - era * 400
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear
  return era * 146097 + dayOfEra - 719468
}

export function isoDate(dayNumberValue: number): string {
  const z = dayNumberValue + 719468
  const era = Math.floor(z / 146097)
  const dayOfEra = z - era * 146097
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365)
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100))
  const mp = Math.floor((5 * dayOfYear + 2) / 153)
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp < 10 ? mp + 3 : mp - 9
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0)
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function isDigits(text: string, min: number, max: number): boolean {
  if (text.length < min || text.length > max) return false
  for (const ch of text) if (ch < '0' || ch > '9') return false
  return true
}

// Strict: the text must fit the declared format exactly. Day and month may omit a leading
// zero. A four-digit-year format never guesses a century for two digits; the two-digit
// formats read them as 20YY, since a statement being reconciled is from this century.
export function parseDate(raw: string, format: DateFormat): DateOutcome {
  const text = raw.trim()
  const { order, separator, namedMonth, shortYear } = PATTERNS[format]
  const misfit: DateOutcome = { ok: false, message: `"${raw}" is not a ${format} date` }
  if (text === '') return { ok: false, message: 'The date is empty' }
  const parts = text.split(separator)
  if (parts.length !== 3) return misfit
  const [a, b, c] = parts
  const [yearText, monthText, dayText] = order === 'ymd' ? [a, b, c] : order === 'dmy' ? [c, b, a] : [c, a, b]
  if (!shortYear && isDigits(yearText, 2, 2)) {
    const short = SHORT_YEAR_OF[format]
    return { ok: false, message: `"${raw}" has a two-digit year${short ? `; choose the ${short} format to read it as 20${yearText}` : ''}` }
  }
  if (!isDigits(yearText, shortYear ? 2 : 4, shortYear ? 2 : 4) || !isDigits(dayText, 1, 2)) return misfit
  let month: number
  if (namedMonth) {
    month = MONTHS.indexOf(monthText.toLowerCase()) + 1
    if (monthText.length !== 3 || month === 0) return misfit
  } else {
    if (!isDigits(monthText, 1, 2)) return misfit
    month = Number(monthText)
  }
  const year = shortYear ? 2000 + Number(yearText) : Number(yearText)
  const day = Number(dayText)
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return { ok: false, message: `"${raw}" is not a real date` }
  }
  return { ok: true, day: dayNumber(year, month, day) }
}
