import Papa from 'papaparse'
import { emptyDict } from './dict'
import { MAX_FIELDS, tooManyFieldsMessage } from './limits'
import { type Delimiter, type ParsedFile, type ParseRules, PROGRESS_EVERY, type ProgressFn, type Row } from './types'

export type ParseIssue =
  | { kind: 'file'; message: string }
  | { kind: 'header'; message: string }
  | { kind: 'record'; recordNumber: number; message: string; raw: string }

export type ParseOutcome =
  | { ok: true; file: ParsedFile }
  | { ok: false; issues: ParseIssue[] }

const UTF8 = new TextDecoder('utf-8', { fatal: true })

// UTF-8 only for v1. Invalid bytes are rejected rather than shown as replacement characters.
export function decodeUtf8(bytes: ArrayBuffer): string | null {
  try {
    return UTF8.decode(bytes)
  } catch {
    return null
  }
}

export const NOT_UTF8_MESSAGE =
  "The file isn't valid UTF-8. Export it again as UTF-8 (in Excel: Save As → CSV UTF-8) and load it again."

const GUESSABLE: Delimiter[] = [',', ';', '\t']

export function headerIssues(headers: string[]): ParseIssue[] {
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

export function parseCsv(
  text: string,
  rules: ParseRules,
  onProgress?: ProgressFn,
  maxFields: number = MAX_FIELDS,
): ParseOutcome {
  const input = text.startsWith('﻿') ? text.slice(1) : text
  let headers: string[] | null = null
  let delimiter: Delimiter = ','
  let fatal: ParseIssue[] = []
  let tooLarge = false
  const rows: Row[] = []
  const issues: ParseIssue[] = []
  let recordNumber = 0
  let previousCursor = 0

  function reportRecord(message: string, raw: string) {
    issues.push({ kind: 'record', recordNumber, message, raw })
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
      if (recordNumber * headers.length > maxFields) {
        tooLarge = true
        parser.abort()
        return
      }
      if (onProgress && recordNumber % PROGRESS_EVERY === 0) onProgress('parse', result.meta.cursor, input.length)
      if (errors.length > 0) {
        reportRecord(errors.map((e) => e.message).join('; '), raw)
      } else if (result.data.length !== headers.length) {
        reportRecord(`Expected ${headers.length} fields, found ${result.data.length}`, raw)
      } else if (issues.length === 0) {
        const row: Row = emptyDict()
        for (let i = 0; i < headers.length; i++) row[headers[i]] = result.data[i]
        rows.push(row)
      }
    },
  })

  onProgress?.('parse', input.length, input.length)
  if (headers === null) {
    return { ok: false, issues: [{ kind: 'header', message: 'The file is empty' }] }
  }
  if (tooLarge) return { ok: false, issues: [{ kind: 'file', message: tooManyFieldsMessage(maxFields) }] }
  if (fatal.length > 0) return { ok: false, issues: fatal }
  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, file: { headers, rows, format: { kind: 'csv', delimiter }, notes: [] } }
}
