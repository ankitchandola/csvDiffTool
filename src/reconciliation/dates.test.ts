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

  it('rejects two-digit years in a four-digit format and names the format that reads them', () => {
    expect(parseDate('1/5/26', 'MM/DD/YYYY')).toEqual({ ok: false, message: '"1/5/26" has a two-digit year; choose the MM/DD/YY format to read it as 2026' })
    expect(parseDate('01.09.26', 'DD.MM.YYYY')).toEqual({ ok: false, message: '"01.09.26" has a two-digit year' })
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

describe('two-digit years and spelled-out months', () => {
  const day = (y: number, m: number, d: number) => ({ ok: true, day: dayNumber(y, m, d) })

  it('reads two-digit years as 20YY in the formats that declare them', () => {
    expect(parseDate('01/09/26', 'DD/MM/YY')).toEqual(day(2026, 9, 1))
    expect(parseDate('1-9-26', 'DD-MM-YY')).toEqual(day(2026, 9, 1))
    expect(parseDate('1-Sep-26', 'DD-Mon-YY')).toEqual(day(2026, 9, 1))
    expect(parseDate('9/1/26', 'MM/DD/YY')).toEqual(day(2026, 9, 1))
    expect(parseDate('29/02/00', 'DD/MM/YY')).toEqual(day(2000, 2, 29))
  })

  it('refuses four-digit years and impossible dates in a two-digit format', () => {
    expect(parseDate('01/09/2026', 'DD/MM/YY')).toEqual({ ok: false, message: '"01/09/2026" is not a DD/MM/YY date' })
    expect(parseDate('29/02/27', 'DD/MM/YY')).toEqual({ ok: false, message: '"29/02/27" is not a real date' })
  })

  it('reads a day, month name and year separated by spaces', () => {
    expect(parseDate('1 Sep 2026', 'DD Mon YYYY')).toEqual(day(2026, 9, 1))
    expect(parseDate(' 01 SEP 2026 ', 'DD Mon YYYY')).toEqual(day(2026, 9, 1))
    expect(parseDate('1  Sep 2026', 'DD Mon YYYY')).toEqual({ ok: false, message: '"1  Sep 2026" is not a DD Mon YYYY date' })
    expect(parseDate('1-Sep-2026', 'DD Mon YYYY')).toEqual({ ok: false, message: '"1-Sep-2026" is not a DD Mon YYYY date' })
  })
})
