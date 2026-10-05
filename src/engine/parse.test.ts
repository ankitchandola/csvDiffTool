import { describe, expect, it } from 'vitest'
import { fixtureText, parsedFixture } from './fixtures.test-helper'
import { MAX_REPORTED_ISSUES, parseCsv } from './parse'

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
      issueCount: 2,
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

  it('caps reported issues but counts them all', () => {
    const text = 'a,b\n' + '1\n'.repeat(MAX_REPORTED_ISSUES + 5)
    const outcome = parseCsv(text, AUTO)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.issues).toHaveLength(MAX_REPORTED_ISSUES)
      expect(outcome.issueCount).toBe(MAX_REPORTED_ISSUES + 5)
    }
  })

  it('rejects an empty file', () => {
    expect(parseCsv('', AUTO)).toMatchObject({ ok: false, issues: [{ message: 'The file is empty' }] })
  })
})
