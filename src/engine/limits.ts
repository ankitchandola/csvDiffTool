// Set from the benchmarks in docs/benchmarks.md. Peak memory grows with the number of
// fields (about 90 bytes each across both files) more than with file size, so both
// limits apply: bytes are checked before reading, fields while parsing. At these limits
// two files peak around 1.1 GB, a quarter of V8's 4 GB heap.
export const MAX_FILE_BYTES = 200 * 2 ** 20
export const MAX_FIELDS = 6_000_000
// Provisional and chosen, not measured at these values: see docs/benchmarks.md#xlsx for the
// Node runs they are set around (two files of 100,000 × 11 fields, 22.6 MiB and 48.4 MiB
// unpacked each, peaked at 1.04 GB). Sheets that aren't compared still cost memory, so the
// byte caps cover the whole workbook.
export const MAX_XLSX_BYTES = 25 * 2 ** 20
export const MAX_UNPACKED_BYTES = 256 * 2 ** 20
export const MAX_XLSX_FIELDS = 2_000_000
// SheetJS Community Edition builds an .xlsx export whole in memory, about 0.9 KB per cell
// in the Node benchmarks (docs/benchmarks.md); 5.7 million cells ran out of a 4 GB heap.
// Provisional: chosen from those runs, then checked by the at-cap benchmark.
export const MAX_XLSX_EXPORT_CELLS = 1_000_000

export interface Limits {
  maxFileBytes: number
  maxXlsxBytes: number
  maxUnpackedBytes: number
  maxFields: number
  maxXlsxFields: number
  maxXlsxExportCells: number
}

export const DEFAULT_LIMITS: Limits = {
  maxFileBytes: MAX_FILE_BYTES,
  maxXlsxBytes: MAX_XLSX_BYTES,
  maxUnpackedBytes: MAX_UNPACKED_BYTES,
  maxFields: MAX_FIELDS,
  maxXlsxFields: MAX_XLSX_FIELDS,
  maxXlsxExportCells: MAX_XLSX_EXPORT_CELLS,
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
