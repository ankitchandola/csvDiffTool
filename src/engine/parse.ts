import Papa from 'papaparse'
import { emptyDict } from './dict'
import { MAX_FIELDS, tooManyFieldsMessage } from './limits'
import {
  type Delimiter,
  type FileFormat,
  type ParsedFile,
  type ParseRules,
  PROGRESS_EVERY,
  type ProgressFn,
  type Row,
  type SkippedRecords,
  type Span,
} from './types'

export type ParseIssue =
  | { kind: 'file'; message: string }
  | { kind: 'header'; message: string }
  | { kind: 'record'; recordNumber: number; message: string; raw: string }

export type ParseOutcome =
  | { ok: true; file: ParsedFile }
  // format is set once the file's sheets are known, so another sheet can be picked.
  | { ok: false; issues: ParseIssue[]; format?: FileFormat }

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

// Bank statements put account details above the table and totals below it. Both
// settings count non-blank records as parsed, never physical lines, so the header always
// starts at a record boundary.
export interface Layout {
  // 1-based: the header is this non-blank record.
  headerRecord: number
  // This many final non-blank records are excluded.
  skipTrailing: number
}

export const DEFAULT_LAYOUT: Layout = { headerRecord: 1, skipTrailing: 0 }

export function layoutIssues({ headerRecord, skipTrailing }: Layout): string[] {
  const issues: string[] = []
  if (!Number.isInteger(headerRecord) || headerRecord < 1) issues.push('The header record must be a whole number of at least 1')
  if (!Number.isInteger(skipTrailing) || skipTrailing < 0) issues.push('Trailing records to skip must be a whole number of at least 0')
  return issues
}

export function tooFewRecordsMessage(found: number, headerRecord: number): string {
  return `The header is set to record ${headerRecord}, but the file has only ${found} non-blank record${found === 1 ? '' : 's'}`
}

interface Pending {
  data: string[]
  errors: string[]
  raw: string
  span: Span
}

function isLineBreak(code: number): boolean {
  return code === 10 || code === 13
}

// Where text starts and ends once leading and trailing line breaks are left out, found by
// walking in from each end: linear however long a run of line breaks is.
function withoutOuterLineBreaks(text: string): [number, number] {
  let start = 0
  let end = text.length
  while (start < end && isLineBreak(text.charCodeAt(start))) start++
  while (end > start && isLineBreak(text.charCodeAt(end - 1))) end--
  return [start, end]
}

// A CRLF pair is one line break; a lone CR or LF is one too. Looks one character past end
// so a CRLF split across two calls is counted once.
function lineBreaks(text: string, start: number, end: number): number {
  let count = 0
  for (let i = start; i < end; i++) {
    const ch = text.charCodeAt(i)
    if (ch === 10 || (ch === 13 && text.charCodeAt(i + 1) !== 10)) count++
  }
  return count
}

// Papa Parse guesses the delimiter from the first records, which for a statement are
// the details above the table. Guess from the header record onwards instead. Records
// before it are counted with comma quoting, as the layout counts them.
function delimiterFromHeader(input: string, headerRecord: number): Delimiter | null {
  let seen = 0
  let previousCursor = 0
  let start = -1
  Papa.parse<string[]>(input, {
    delimiter: ',',
    skipEmptyLines: true,
    step(result, parser) {
      seen++
      if (seen === headerRecord) {
        start = previousCursor
        parser.abort()
        return
      }
      previousCursor = result.meta.cursor
    },
  })
  if (start < 0) return null
  const guess = Papa.parse<string[]>(input.slice(start), { delimitersToGuess: GUESSABLE, preview: 10, skipEmptyLines: true })
  return (GUESSABLE as string[]).includes(guess.meta.delimiter) ? (guess.meta.delimiter as Delimiter) : null
}

// Without a layout this is Compare's reader: the first non-blank record is the header and
// no spans or skipped records are kept.
export function parseCsv(
  text: string,
  rules: ParseRules,
  onProgress?: ProgressFn,
  maxFields: number = MAX_FIELDS,
  layout?: Layout,
): ParseOutcome {
  const input = text.startsWith('\uFEFF') ? text.slice(1) : text
  const { headerRecord, skipTrailing } = layout ?? DEFAULT_LAYOUT
  let headers: string[] | null = null
  let delimiter: Delimiter = ','
  let fatal: ParseIssue[] = []
  let tooLarge = false
  const rows: Row[] = []
  const spans: Span[] = []
  const skipped: SkippedRecords = { before: [], after: [] }
  const issues: ParseIssue[] = []
  const pending: Pending[] = []
  let seen = 0
  let recordNumber = 0
  let previousCursor = 0
  let breaksBefore = 0

  function accept({ data, errors, raw, span }: Pending): boolean {
    const width = (headers as string[]).length
    recordNumber++
    if (recordNumber * width > maxFields) {
      tooLarge = true
      return false
    }
    if (errors.length > 0) {
      issues.push({ kind: 'record', recordNumber, message: errors.join('; '), raw })
    } else if (data.length !== width) {
      issues.push({ kind: 'record', recordNumber, message: `Expected ${width} fields, found ${data.length}`, raw })
    } else if (issues.length === 0) {
      const row: Row = emptyDict()
      for (let i = 0; i < width; i++) row[(headers as string[])[i]] = data[i]
      rows.push(row)
      if (layout) spans.push(span)
    }
    return true
  }

  const explicit = rules.delimiter !== 'auto' ? rules.delimiter : headerRecord > 1 ? delimiterFromHeader(input, headerRecord) : null

  Papa.parse<string[]>(input, {
    delimiter: explicit ?? '',
    delimitersToGuess: GUESSABLE,
    dynamicTyping: false,
    skipEmptyLines: true,
    step(result, parser) {
      const cursor = result.meta.cursor
      const segment = input.slice(previousCursor, cursor)
      const [leading, end] = withoutOuterLineBreaks(segment)
      const raw = segment.slice(leading, end)
      const first = breaksBefore + lineBreaks(input, previousCursor, previousCursor + leading) + 1
      const span = { first, last: first + lineBreaks(raw, 0, raw.length) }
      breaksBefore += lineBreaks(input, previousCursor, cursor)
      previousCursor = cursor
      // A single-column file has no delimiter to detect; that is not an error.
      const errors = result.errors.filter((e) => e.code !== 'UndetectableDelimiter')
      seen++

      if (seen < headerRecord) {
        if (errors.length > 0) {
          fatal = errors.map((e): ParseIssue => ({ kind: 'header', message: `Record ${seen}, before the header: ${e.message}` }))
          parser.abort()
          return
        }
        skipped.before.push(raw)
        return
      }

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

      pending.push({ data: result.data, errors: errors.map((e) => e.message), raw, span })
      if (pending.length > skipTrailing && !accept(pending.shift() as Pending)) {
        parser.abort()
        return
      }
      if (onProgress && recordNumber > 0 && recordNumber % PROGRESS_EVERY === 0) onProgress('parse', cursor, input.length)
    },
  })

  onProgress?.('parse', input.length, input.length)
  if (headers === null) {
    if (fatal.length > 0) return { ok: false, issues: fatal }
    const message = layout && seen > 0 ? tooFewRecordsMessage(seen, headerRecord) : 'The file is empty'
    return { ok: false, issues: [{ kind: 'header', message }] }
  }
  if (tooLarge) return { ok: false, issues: [{ kind: 'file', message: tooManyFieldsMessage(maxFields) }] }
  if (fatal.length > 0) return { ok: false, issues: fatal }
  // A parse error in a skipped record is not just footer text: an unclosed quote there
  // can have swallowed transactions that follow it.
  for (const p of pending) {
    recordNumber++
    if (p.errors.length > 0) {
      issues.push({ kind: 'record', recordNumber, message: `${p.errors.join('; ')} (in a record set to be skipped at the end)`, raw: p.raw })
    }
  }
  if (issues.length > 0) return { ok: false, issues }
  skipped.after = pending.map((p) => p.raw)
  const file: ParsedFile = { headers, rows, format: { kind: 'csv', delimiter }, notes: [] }
  return { ok: true, file: layout ? { ...file, spans, skipped } : file }
}
