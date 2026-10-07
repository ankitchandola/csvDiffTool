import { fileTooLargeMessage, type Limits } from '../engine/limits'
import { decodeUtf8, type Layout, NOT_UTF8_MESSAGE, type ParseOutcome, parseCsv } from '../engine/parse'
import type { ParseRules, ProgressFn } from '../engine/types'

export const LEGACY_EXCEL_MESSAGE =
  'This looks like an old .xls or a password-protected workbook, which are not supported. Open it in Excel and save it as .xlsx (without a password) or CSV UTF-8.'

export class SupersededError extends Error {
  constructor() {
    super('Superseded by a newer file')
  }
}

const failed = (message: string): ParseOutcome => ({ ok: false, issues: [{ kind: 'file', message }] })

function isXlsxName(name: string): boolean {
  return name.toLowerCase().endsWith('.xlsx')
}

// Zip archives start PK\x03\x04; old .xls and encrypted workbooks are OLE files, D0 CF 11 E0.
function sniff(bytes: ArrayBuffer): 'zip' | 'legacy' | 'text' {
  const head = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength))
  const starts = (...expected: number[]) => expected.every((b, i) => head[i] === b)
  if (starts(0x50, 0x4b, 0x03, 0x04)) return 'zip'
  if (starts(0xd0, 0xcf, 0x11, 0xe0)) return 'legacy'
  return 'text'
}

export interface ReadOptions {
  rules: ParseRules
  // Omitted means the first sheet.
  sheet?: string
  // Omitted keeps Compare's rule: the first non-blank record is the header.
  layout?: Layout
}

export interface SourceRead {
  outcome: ParseOutcome
  // Null when the file was refused before being read.
  bytes: ArrayBuffer | null
}

// isCurrent lets the caller drop a read that a newer file for the same side replaced.
export async function readSource(
  file: File,
  { rules, sheet, layout }: ReadOptions,
  limits: Limits,
  isCurrent: () => boolean,
  onProgress?: ProgressFn,
): Promise<SourceRead> {
  const xlsxName = isXlsxName(file.name)
  const maxBytes = xlsxName ? limits.maxXlsxBytes : limits.maxFileBytes
  if (file.size > maxBytes) return { outcome: failed(fileTooLargeMessage(file.size, maxBytes)), bytes: null }
  const bytes = await file.arrayBuffer()
  if (!isCurrent()) throw new SupersededError()
  const kind = sniff(bytes)
  if (kind === 'legacy') return { outcome: failed(LEGACY_EXCEL_MESSAGE), bytes }
  if (kind === 'zip' || xlsxName) {
    if (file.size > limits.maxXlsxBytes) return { outcome: failed(fileTooLargeMessage(file.size, limits.maxXlsxBytes)), bytes }
    const { parseXlsx } = await import('../engine/xlsx')
    if (!isCurrent()) throw new SupersededError()
    return { outcome: parseXlsx(bytes, sheet, limits, onProgress, layout), bytes }
  }
  const text = decodeUtf8(bytes)
  return { outcome: text === null ? failed(NOT_UTF8_MESSAGE) : parseCsv(text, rules, onProgress, limits.maxFields, layout), bytes }
}
