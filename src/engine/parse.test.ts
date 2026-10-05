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
    expect(file.delimiter).toBe(';')
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
