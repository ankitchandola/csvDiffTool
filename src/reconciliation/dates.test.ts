import { describe, expect, it } from 'vitest'
import { type DateFormat, dayNumber, isoDate, parseDate } from './dates'

function iso(text: string, format: DateFormat): string {
  const outcome = parseDate(text, format)
  if (!outcome.ok) throw new Error(outcome.message)
  return isoDate(outcome.day)
}

describe('parseDate', () => {
  it.each<[string, DateFormat, string]>([
    ['2026-01-05', 'YYYY-MM-DD', '2026-01-05'],
    ['2026-1-5', 'YYYY-MM-DD', '2026-01-05'],
    ['05/01/2026', 'DD/MM/YYYY', '2026-01-05'],
    ['5-1-2026', 'DD-MM-YYYY', '2026-01-05'],
    ['05.01.2026', 'DD.MM.YYYY', '2026-01-05'],
    ['01/05/2026', 'MM/DD/YYYY', '2026-01-05'],
    ['1-5-2026', 'MM-DD-YYYY', '2026-01-05'],
    ['05-Jan-2026', 'DD-Mon-YYYY', '2026-01-05'],
    ['5-JAN-2026', 'DD-Mon-YYYY', '2026-01-05'],
    [' 29/02/2024 ', 'DD/MM/YYYY', '2024-02-29'],
  ])('reads %j as %s', (text, format, expected) => {
    expect(iso(text, format)).toBe(expected)
  })

  it.each<[string, DateFormat]>([
    ['29/02/2026', 'DD/MM/YYYY'],
    ['31/04/2026', 'DD/MM/YYYY'],
    ['13/01/2026', 'MM/DD/YYYY'],
    ['00/01/2026', 'DD/MM/YYYY'],
    ['29-02-1900', 'DD-MM-YYYY'],
  ])('rejects impossible %j', (text, format) => {
    expect(parseDate(text, format)).toEqual({ ok: false, message: `"${text}" is not a real date` })
  })

  it.each<[string, DateFormat]>([
    ['2026/01/05', 'YYYY-MM-DD'],
    ['05-01-2026', 'DD/MM/YYYY'],
    ['05/01/2026 10:30', 'DD/MM/YYYY'],
    ['05-January-2026', 'DD-Mon-YYYY'],
    ['05-Jnu-2026', 'DD-Mon-YYYY'],
    ['5 Jan 2026', 'DD-Mon-YYYY'],
    ['46027', 'YYYY-MM-DD'],
  ])('rejects %j that does not fit %s', (text, format) => {
    expect(parseDate(text, format)).toEqual({ ok: false, message: `"${text}" is not a ${format} date` })
  })

  it('rejects two-digit years with a reason, as SheetJS shows m/d/yy', () => {
    expect(parseDate('1/5/26', 'MM/DD/YYYY')).toEqual({ ok: false, message: '"1/5/26" has a two-digit year; only four-digit years are read' })
  })

  it('reports an empty date', () => {
    expect(parseDate('  ', 'YYYY-MM-DD')).toEqual({ ok: false, message: 'The date is empty' })
  })
})

describe('day numbers', () => {
  it('count calendar days without time zones', () => {
    expect(dayNumber(1970, 1, 1)).toBe(0)
    expect(dayNumber(2024, 3, 1) - dayNumber(2024, 2, 28)).toBe(2)
    expect(dayNumber(2026, 3, 1) - dayNumber(2026, 2, 28)).toBe(1)
    expect(dayNumber(2027, 1, 1) - dayNumber(2026, 12, 31)).toBe(1)
  })

  it('round-trip through ISO text', () => {
    for (const day of [-1, 0, 59, 19_000, 20_454, 2_932_896]) {
      const [y, m, d] = isoDate(day).split('-').map(Number)
      expect(dayNumber(y, m, d)).toBe(day)
    }
  })
})
