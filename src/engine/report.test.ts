import Papa from 'papaparse'
import { describe, expect, it, vi } from 'vitest'
import { diffFiles } from './diff'
import { profile } from './fixtures.test-helper'
import { parseCsv } from './parse'
import { buildChangesCsv, buildJsonReport, CHANGES_CSV_HEADER, keyCell, type ReportInput } from './report'
import type { CompareProfile } from './types'

function parsed(text: string) {
  const outcome = parseCsv(text, { delimiter: 'auto', trimHeaders: true })
  if (!outcome.ok) throw new Error('parse failed')
  return outcome.file
}

function input(oldText: string, newText: string, p: CompareProfile = profile({ columns: ['id'] })): ReportInput {
  const oldFile = parsed(oldText)
  const newFile = parsed(newText)
  return {
    diff: diffFiles(oldFile, newFile, p),
    oldFile,
    newFile,
    oldName: 'yesterday.csv',
    newName: 'today.csv',
    generatedAt: '2026-10-05T12:00:00.000Z',
  }
}

function readCsv(chunks: string[]): string[][] {
  const text = chunks.join('')
  expect(text.startsWith('﻿')).toBe(true)
  return Papa.parse<string[]>(text.slice(1), { skipEmptyLines: true }).data
}

const OLD = 'id,name,note\n1,apple,plain\n2,"pear, green","said ""hi"""\n3,plum,x\n'
const NEW = 'id,name,note\n1,apple,"two\nlines"\n3,plum,x\n4,fig, padded \n'

describe('buildChangesCsv', () => {
  it('writes one line per field in long format', () => {
    expect(readCsv(buildChangesCsv(input(OLD, NEW)))).toEqual([
      CHANGES_CSV_HEADER,
      ['added', '4', 'id', '', '4'],
      ['added', '4', 'name', '', 'fig'],
      ['added', '4', 'note', '', ' padded '],
      ['removed', '2', 'id', '2', ''],
      ['removed', '2', 'name', 'pear, green', ''],
      ['removed', '2', 'note', 'said "hi"', ''],
      ['changed', '1', 'note', 'plain', 'two\nlines'],
    ])
  })

  it('writes a composite key as a JSON array', () => {
    const rows = readCsv(
      buildChangesCsv(input('w,sku,qty\nw1,001,1\n', 'w,sku,qty\nw1,001,2\n', profile({ columns: ['w', 'sku'] }))),
    )
    expect(rows[1]).toEqual(['changed', '["w1","001"]', 'qty', '1', '2'])
    expect(keyCell(['a'])).toBe('a')
  })

  it('reports progress up to the total', () => {
    const onProgress = vi.fn()
    buildChangesCsv(input(OLD, NEW), {}, onProgress)
    expect(onProgress).toHaveBeenLastCalledWith('export', 3, 3)
  })

  it('splits large exports into chunks without losing lines', () => {
    const rows = Array.from({ length: 30000 }, (_, i) => `${i},${'x'.repeat(30)},y`).join('\n')
    const chunks = buildChangesCsv(input('id,name,note\n', `id,name,note\n${rows}\n`))
    expect(chunks.length).toBeGreaterThan(1)
    expect(readCsv(chunks)).toHaveLength(1 + 30000 * 3)
  })
})

describe('buildJsonReport', () => {
  it('starts with the rules used and contains every section', () => {
    const p = profile({ columns: ['id'] }, { ignoredColumns: ['name'] })
    const text = buildJsonReport(input(OLD, NEW, p)).join('')
    expect(text.indexOf('"rulesUsed"')).toBeLessThan(text.indexOf('"summary"'))
    const report = JSON.parse(text)
    expect(report).toMatchObject({
      format: 'csv-diff-report',
      version: 1,
      rulesUsed: p,
      files: { old: 'yesterday.csv', new: 'today.csv' },
      generatedAt: '2026-10-05T12:00:00.000Z',
      summary: { counts: { added: 1, removed: 1, changed: 1 } },
      added: [{ key: ['4'], recordNumber: 3, record: { id: '4', name: 'fig', note: ' padded ' } }],
      removed: [{ key: ['2'], recordNumber: 2, record: { name: 'pear, green' } }],
      changed: [{ key: ['1'], oldKey: ['1'], oldRecordNumber: 1, newRecordNumber: 1 }],
      ambiguous: [],
      emptyKey: [],
      warnings: [],
    })
    expect(report.summary.rulesUsed).toBeUndefined()
  })

  it('includes ambiguous keys, empty keys and warnings in full', () => {
    const dupes = Array.from({ length: 15 }, (_, i) => `1,${i}`).join('\n')
    const report = JSON.parse(buildJsonReport(input(`id,v\n${dupes}\n,x\n`, 'id,v\n1,a\n')).join(''))
    expect(report.ambiguous[0].old).toHaveLength(15)
    expect(report.emptyKey).toEqual([{ side: 'old', recordNumber: 16, parts: [''] }])
  })

  it('keeps a __proto__ column as data', () => {
    const report = JSON.parse(buildJsonReport(input('id,__proto__\n1,a\n', 'id,__proto__\n2,b\n')).join(''))
    expect(report.added[0].record).toEqual(JSON.parse('{"id":"2","__proto__":"b"}'))
  })
})

describe('buildChangesCsv key column', () => {
  it('escapes a composite key as one quoted CSV field, keeping the original parts', () => {
    const text = buildChangesCsv(
      input('warehouse,sku,price\nw1,001,10\n', 'warehouse,sku,price\nw1,001,12\n', profile({ columns: ['warehouse', 'sku'] })),
    ).join('')
    expect(text).toBe('﻿change_type,key,column,before,after\r\nchanged,"[""w1"",""001""]",price,10,12\r\n')
  })

  it('writes the key as typed in the file, not its normalised matching form', () => {
    const p = profile({ columns: ['sku'], trim: true, caseInsensitive: true })
    const rows = readCsv(buildChangesCsv(input('sku,qty\n0042,1\n', 'sku,qty\n 0042 ,2\n', p)))
    // Value rules don't trim, so the key column's own spacing change is reported too.
    expect(rows.slice(1)).toEqual([
      ['changed', ' 0042 ', 'sku', '0042', ' 0042 '],
      ['changed', ' 0042 ', 'qty', '1', '2'],
    ])
  })
})

describe('buildChangesCsv formula escaping', () => {
  const RISKY = ['=1+1', '+cmd|calc', '-1+1', '@SUM(A1)', '\tx', '\rx', '-1,234']
  const SAFE = ['-12', '+3.5', '-0.25', '.5', 'plain', '12-3', '1=1', "'quoted", '1234.50-', '1,23,456.00']

  function changed(values: string[]) {
    const oldText = 'id,v\n' + values.map((_, i) => `${i},old`).join('\n') + '\n'
    const newText = 'id,v\n' + values.map((v, i) => `${i},"${v}"`).join('\n') + '\n'
    return input(oldText, newText)
  }

  function afterValues(chunks: string[]) {
    return readCsv(chunks)
      .slice(1)
      .map((row) => row[4])
  }

  it.each(RISKY)('prefixes %j with an apostrophe', (value) => {
    expect(afterValues(buildChangesCsv(changed([value])))).toEqual([`'${value}`])
  })

  it.each(SAFE)('leaves %j unchanged', (value) => {
    expect(afterValues(buildChangesCsv(changed([value])))).toEqual([value])
  })

  it('escapes a formula-like key too', () => {
    const rows = readCsv(buildChangesCsv(input('id,v\n=A1,1\n', 'id,v\n=A1,2\n')))
    expect(rows[1].slice(0, 2)).toEqual(['changed', "'=A1"])
  })

  it('writes values as read when escaping is turned off', () => {
    expect(afterValues(buildChangesCsv(changed(RISKY), { escapeFormulae: false }))).toEqual(RISKY)
  })

  it('keeps original values in the JSON report', () => {
    const report = JSON.parse(buildJsonReport(changed(RISKY)).join(''))
    expect(report.changed.map((c: { changes: { after: string }[] }) => c.changes[0].after)).toEqual(RISKY)
  })

  it('never modifies the comparison result it exports', () => {
    const report = changed([...RISKY, ...SAFE])
    const before = structuredClone(report)
    buildChangesCsv(report)
    buildJsonReport(report)
    expect(report).toEqual(before)
  })
})
