// Set from the benchmarks in docs/benchmarks.md. Peak memory grows with the number of
// fields (about 90 bytes each across both files) more than with file size, so both
// limits apply: bytes are checked before reading, fields while parsing. At these limits
// two files peak around 1.1 GB, a quarter of V8's 4 GB heap.
export const MAX_FILE_BYTES = 200 * 2 ** 20
export const MAX_FIELDS = 6_000_000

export interface Limits {
  maxFileBytes: number
  maxFields: number
}

export const DEFAULT_LIMITS: Limits = { maxFileBytes: MAX_FILE_BYTES, maxFields: MAX_FIELDS }

function mebibytes(bytes: number): string {
  return `${Math.ceil(bytes / 2 ** 20).toLocaleString('en-US')} MiB`
}

export function fileTooLargeMessage(size: number, limit: number): string {
  return `This file is ${mebibytes(size)}; the limit is ${mebibytes(limit)} per file, so that a comparison fits in browser memory. Compare a smaller extract or split the export.`
}

export function tooManyFieldsMessage(limit: number): string {
  return `This file has more than ${limit.toLocaleString('en-US')} fields (records × columns); that is the limit per file, so that a comparison fits in browser memory. Compare a smaller extract or fewer columns.`
}
