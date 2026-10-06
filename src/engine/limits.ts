// Set from the benchmarks in docs/benchmarks.md. Peak memory grows with the number of
// fields (about 90 bytes each across both files) more than with file size, so both
// limits apply: bytes are checked before reading, fields while parsing. At these limits
// two files peak around 1.1 GB, a quarter of V8's 4 GB heap.
export const MAX_FILE_BYTES = 200 * 2 ** 20
export const MAX_FIELDS = 6_000_000
// Provisional until the benchmark has an .xlsx case: a workbook holds far more bytes per
// cell in memory than CSV, and its zipped size says little about its unpacked size.
export const MAX_XLSX_BYTES = 50 * 2 ** 20
export const MAX_UNPACKED_BYTES = 512 * 2 ** 20

export interface Limits {
  maxFileBytes: number
  maxXlsxBytes: number
  maxUnpackedBytes: number
  maxFields: number
}

export const DEFAULT_LIMITS: Limits = {
  maxFileBytes: MAX_FILE_BYTES,
  maxXlsxBytes: MAX_XLSX_BYTES,
  maxUnpackedBytes: MAX_UNPACKED_BYTES,
  maxFields: MAX_FIELDS,
}

function mebibytes(bytes: number): string {
  return `${Math.ceil(bytes / 2 ** 20).toLocaleString('en-US')} MiB`
}

export function fileTooLargeMessage(size: number, limit: number): string {
  return `This file is ${mebibytes(size)}; the limit is ${mebibytes(limit)} per file, so that a comparison fits in browser memory. Compare a smaller extract or split the export.`
}

export function unpackedTooLargeMessage(limit: number): string {
  return `This workbook unpacks to more than ${mebibytes(limit)}, so it won't fit in browser memory. Save the sheet you need as its own workbook or as CSV UTF-8.`
}

export function tooManyFieldsMessage(limit: number): string {
  return `This file has more than ${limit.toLocaleString('en-US')} fields (records × columns); that is the limit per file, so that a comparison fits in browser memory. Compare a smaller extract or fewer columns.`
}
