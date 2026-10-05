import Papa from 'papaparse'
import type { Delimiter, ParsedFile, ParseRules, Row } from './types'

export type ParseIssue =
  | { kind: 'header'; message: string }
  | { kind: 'record'; recordNumber: number; message: string; raw: string }

export type ParseOutcome =
  | { ok: true; file: ParsedFile }
  | { ok: false; issues: ParseIssue[]; issueCount: number }

export const MAX_REPORTED_ISSUES = 20

const GUESSABLE: Delimiter[] = [',', ';', '\t']

function headerIssues(headers: string[]): ParseIssue[] {
  const issues: ParseIssue[] = []
  const seen = new Set<string>()
  headers.forEach((name, i) => {
    if (name === '') {
      issues.push({ kind: 'header', message: `Column ${i + 1} has an empty header` })
    } else if (seen.has(name)) {
      issues.push({ kind: 'header', message: `Header "${name}" appears more than once` })
    }
    seen.add(name)
  })
  return issues
}

export function parseCsv(text: string, rules: ParseRules): ParseOutcome {
  const input = text.startsWith('﻿') ? text.slice(1) : text
  let headers: string[] | null = null
  let delimiter: Delimiter = ','
  let fatal: ParseIssue[] = []
  const rows: Row[] = []
  const issues: ParseIssue[] = []
  let issueCount = 0
  let recordNumber = 0
  let previousCursor = 0

  function reportRecord(message: string, raw: string) {
    issueCount++
    if (issues.length < MAX_REPORTED_ISSUES) {
      issues.push({ kind: 'record', recordNumber, message, raw })
    }
  }

  Papa.parse<string[]>(input, {
    delimiter: rules.delimiter === 'auto' ? '' : rules.delimiter,
    delimitersToGuess: GUESSABLE,
    dynamicTyping: false,
    skipEmptyLines: true,
    step(result, parser) {
      const raw = input.slice(previousCursor, result.meta.cursor).replace(/^[\r\n]+|[\r\n]+$/g, '')
      previousCursor = result.meta.cursor
      // A single-column file has no delimiter to detect; that is not an error.
      const errors = result.errors.filter((e) => e.code !== 'UndetectableDelimiter')

      if (headers === null) {
        delimiter = (GUESSABLE as string[]).includes(result.meta.delimiter)
          ? (result.meta.delimiter as Delimiter)
          : ','
        headers = result.data.map((h) => h.trim())
        fatal = [
          ...errors.map((e): ParseIssue => ({ kind: 'header', message: e.message })),
          ...headerIssues(headers),
        ]
        if (fatal.length > 0) parser.abort()
        return
      }

      recordNumber++
      if (errors.length > 0) {
        reportRecord(errors.map((e) => e.message).join('; '), raw)
      } else if (result.data.length !== headers.length) {
        reportRecord(`Expected ${headers.length} fields, found ${result.data.length}`, raw)
      } else if (issueCount === 0) {
        const row: Row = {}
        for (let i = 0; i < headers.length; i++) row[headers[i]] = result.data[i]
        rows.push(row)
      }
    },
  })

  if (headers === null) {
    return { ok: false, issues: [{ kind: 'header', message: 'The file is empty' }], issueCount: 1 }
  }
  if (fatal.length > 0) return { ok: false, issues: fatal, issueCount: fatal.length }
  if (issueCount > 0) return { ok: false, issues, issueCount }
  return { ok: true, file: { headers, rows, delimiter } }
}
