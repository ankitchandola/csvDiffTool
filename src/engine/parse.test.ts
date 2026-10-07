import { describe, expect, it } from 'vitest'
import { fixtureText, parsedFixture } from './fixtures.test-helper'
import { tooManyFieldsMessage } from './limits'
import { decodeUtf8, parseCsv } from './parse'

const AUTO = { delimiter: 'auto', trimHeaders: true } as const

describe('parseCsv', () => {
  it('keeps every value as a string, including leading zeros', () => {
    const file = parsedFixture('leading-zeros', 'old')
    expect(file.rows[0]).toEqual({ sku: '00123', code: '0007' })
  })

  it('strips a BOM, detects a semicolon delimiter and trims headers', () => {
    const file = parsedFixture('bom-semicolon', 'old')
    expect(file.format).toEqual({ kind: 'csv', delimiter: ';' })
    expect(file.headers).toEqual(['id', 'name', 'qty'])
    expect(file.rows[1]).toEqual({ id: '2', name: 'b', qty: '4' })
  })

  it('honours a manual delimiter override', () => {
    const outcome = parseCsv('a;b\n1;2\n', { delimiter: ',', trimHeaders: true })
    expect(outcome.ok && outcome.file.headers).toEqual(['a;b'])
  })

  it('treats a quoted embedded newline as part of one record', () => {
    const file = parsedFixture('embedded-newline', 'old')
    expect(file.rows).toHaveLength(2)
    expect(file.rows[0].note).toBe('line one\nline two')
  })

  it('parses a single-column file', () => {
    const outcome = parseCsv('id\n1\n2\n', AUTO)
    expect(outcome.ok && outcome.file.rows).toEqual([{ id: '1' }, { id: '2' }])
  })

  it('rejects a duplicate header', () => {
    const outcome = parseCsv(fixtureText('malformed', 'old'), AUTO)
    expect(outcome).toMatchObject({
      ok: false,
      issues: [{ kind: 'header', message: 'Header "id" appears more than once' }],
    })
  })

  it('rejects an empty header', () => {
    const outcome = parseCsv(fixtureText('malformed', 'new'), AUTO)
    expect(outcome).toMatchObject({ ok: false, issues: [{ kind: 'header', message: 'Column 2 has an empty header' }] })
  })

  it('rejects a header that is only whitespace, and treats "id " and "id" as duplicates', () => {
    const outcome = parseCsv('id, ,id \n1,2,3\n', AUTO)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.issues).toHaveLength(2)
  })

  it('reports field-count mismatches by record number with raw text', () => {
    const outcome = parseCsv(fixtureText('field-mismatch', 'new'), AUTO)
    expect(outcome).toEqual({
      ok: false,
      issues: [
        { kind: 'record', recordNumber: 2, message: 'Expected 2 fields, found 3', raw: '2,b,extra' },
        { kind: 'record', recordNumber: 3, message: 'Expected 2 fields, found 1', raw: '3' },
      ],
    })
  })

  it('counts records, not lines, when a quoted field spans lines', () => {
    const outcome = parseCsv('id,note\n1,"a\nb"\n2,x,y\n', AUTO)
    expect(outcome).toMatchObject({ ok: false, issues: [{ recordNumber: 2, raw: '2,x,y' }] })
  })

  it('keeps every record issue, not just the first few', () => {
    const outcome = parseCsv('a,b\n' + '1\n'.repeat(2340), AUTO)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.issues).toHaveLength(2340)
  })

  it('rejects an empty file', () => {
    expect(parseCsv('', AUTO)).toMatchObject({ ok: false, issues: [{ message: 'The file is empty' }] })
  })
})

describe('decodeUtf8', () => {
  it('decodes valid UTF-8 and drops a BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('id,naïve\n')])
    expect(decodeUtf8(bytes.buffer)).toBe('id,naïve\n')
  })

  it('rejects bytes that are not UTF-8, such as a Windows-1252 export', () => {
    // "café" in Windows-1252: é is the single byte 0xE9.
    expect(decodeUtf8(new Uint8Array([0x63, 0x61, 0x66, 0xe9]).buffer)).toBeNull()
  })
})

describe('parseCsv field limit', () => {
  it('accepts a file exactly at the limit', () => {
    expect(parseCsv('a,b\n1,2\n3,4\n', AUTO, undefined, 4).ok).toBe(true)
  })

  it('stops with a clear message once records × columns exceed the limit', () => {
    expect(parseCsv('a,b\n1,2\n3,4\n5,6\n', AUTO, undefined, 4)).toEqual({
      ok: false,
      issues: [{ kind: 'file', message: tooManyFieldsMessage(4) }],
    })
    expect(tooManyFieldsMessage(6_000_000)).toMatch('more than 6,000,000 fields')
  })
})

describe('parseCsv with a layout', () => {
  const statement = [
    'Account,12345678',
    'Statement period,01/09/2026 to 30/09/2026',
    '',
    'Date,Details,Amount',
    '01/09/2026,Opening,0',
    '02/09/2026,"Rent, September",-500.00',
    'Closing balance,,-500.00,extra',
    '',
  ].join('\r\n')

  function read(text: string, headerRecord: number, skipTrailing = 0) {
    return parseCsv(text, { delimiter: ',', trimHeaders: true }, undefined, undefined, { headerRecord, skipTrailing })
  }

  it('reads the header at a record number and skips trailing records before field-count checks', () => {
    const outcome = read(statement, 3, 1)
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
    expect(outcome.file.headers).toEqual(['Date', 'Details', 'Amount'])
    expect(outcome.file.rows).toEqual([
      { Date: '01/09/2026', Details: 'Opening', Amount: '0' },
      { Date: '02/09/2026', Details: 'Rent, September', Amount: '-500.00' },
    ])
    expect(outcome.file.skipped).toEqual({
      before: ['Account,12345678', 'Statement period,01/09/2026 to 30/09/2026'],
      after: ['Closing balance,,-500.00,extra'],
    })
    expect(outcome.file.spans).toEqual([{ first: 5, last: 5 }, { first: 6, last: 6 }])
  })

  it('still rejects a trailing record that is not skipped', () => {
    const outcome = read(statement, 3)
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.issues[0]).toMatchObject({ kind: 'record', recordNumber: 3, message: 'Expected 3 fields, found 4' })
  })

  it('counts records, not lines, so a quoted preamble field spanning lines cannot shift the header', () => {
    const text = 'Note\n"line one\nline two"\nid,amount\n1,"multi\nline"\n2,5\n'
    const outcome = read(text, 3)
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
    expect(outcome.file.headers).toEqual(['id', 'amount'])
    expect(outcome.file.skipped?.before).toEqual(['Note', '"line one\nline two"'])
    expect(outcome.file.spans).toEqual([{ first: 5, last: 6 }, { first: 7, last: 7 }])
  })

  it('reads a quote inside preamble prose literally', () => {
    const outcome = read('Statement for "Savings\nid,amount\n1,5\n', 2)
    expect(outcome.ok && outcome.file.skipped?.before).toEqual(['Statement for "Savings'])
  })

  it('rejects preamble text with an unterminated quoted field rather than guessing', () => {
    const outcome = read('"Statement for Savings\nid,amount\n1,5\n', 2)
    expect(outcome.ok).toBe(false)
  })

  it('reports a header record beyond the file', () => {
    const outcome = read('a\nb\n', 5)
    expect(!outcome.ok && outcome.issues).toEqual([
      { kind: 'header', message: 'The header is set to record 5, but the file has only 2 non-blank records' },
    ])
  })

  it('keeps Compare output unchanged without a layout', () => {
    const outcome = parseCsv('id,v\n1,2\n', AUTO)
    expect(outcome.ok && outcome.file).toEqual({ headers: ['id', 'v'], rows: [{ id: '1', v: '2' }], format: { kind: 'csv', delimiter: ',' }, notes: [] })
  })
})

describe('parseCsv layout safeguards', () => {
  it('rejects a skipped trailing record with a parse error, which can hide transactions', () => {
    const text = 'date,amount\n01/09/2026,10\n"02/09/2026,20\n03/09/2026,30\nClosing,60\n'
    const outcome = parseCsv(text, { delimiter: ',', trimHeaders: true }, undefined, undefined, { headerRecord: 1, skipTrailing: 1 })
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.issues[0]).toMatchObject({ kind: 'record', recordNumber: 2, message: 'Quoted field unterminated (in a record set to be skipped at the end)' })
  })

  it('detects the delimiter from the header record, not the details above it', () => {
    const preamble = Array.from({ length: 12 }, (_, i) => `Statement line ${i}`).join('\n')
    const text = `${preamble}\nDate;Amount;Ref\n01/09/2026;10;A\n02/09/2026;20;B\n`
    const outcome = parseCsv(text, AUTO, undefined, undefined, { headerRecord: 13, skipTrailing: 0 })
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
    expect(outcome.file.headers).toEqual(['Date', 'Amount', 'Ref'])
    expect(outcome.file.format).toEqual({ kind: 'csv', delimiter: ';' })
  })

  it('keeps an explicit delimiter as chosen', () => {
    const outcome = parseCsv('Note\nDate;Amount\n1;2\n', { delimiter: ',', trimHeaders: true }, undefined, undefined, { headerRecord: 2, skipTrailing: 0 })
    expect(outcome.ok && outcome.file.headers).toEqual(['Date;Amount'])
  })
})
