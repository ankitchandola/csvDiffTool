# .xlsx input

Either side of a comparison can be an `.xlsx` workbook instead of a CSV. One sheet
per file is compared, using each cell's **displayed text**, so an `.xlsx` and a
"Save as CSV UTF-8" of the same sheet compare as equal. Everything after reading
(keys, rules, results, exports, profiles) is unchanged.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Formats | `.xlsx` only. `.xls` and password-protected workbooks are rejected with a "save as .xlsx or CSV UTF-8" message. | `.xlsx` is what current tools write; `.xls` would add testing for a shrinking source. |
| Library | SheetJS 0.20.3, installed from `cdn.sheetjs.com` (the npm `xlsx` package is stuck at 0.18.5 with known advisories). Imported only when an `.xlsx` is read, inside the worker. | It is the only library that renders Excel number formats as display text. Lazy loading keeps CSV users from downloading it. |
| Cell value | Displayed text (`raw: false`): `1,234.50`, `2026-01-05`, `12%`. | Matches what users see and what a CSV export holds. Display rounding can hide a difference finer than the format shows; the UI says so. |
| Formulas | The value Excel last saved. Nothing is recalculated. | The file holds no other answer. |
| Sheet | The first sheet by default; a picker per file when the workbook has more than one. Only the chosen sheet is unpacked. | Most exports have one sheet; reading one sheet saves memory. |
| Header | Row 1 of the sheet's used range. | Same rule as CSV. |
| Short rows | Missing trailing cells are empty values. | Excel doesn't store empty cells; that is not an error, unlike a short CSV record. |
| Cells beyond the header | Reported as record problems and the file is rejected, like a CSV record with too many fields. Empty columns past the last header are ignored. | A value with no column name can't be compared. |
| Merged cells, hidden rows/columns | Read as stored (a merge's value sits in its top-left cell; hidden rows count) and noted under the file. | Silent surprises are worse than a note. |
| Leading zeros | Kept for cells stored as text. A `0007` Excel already stored as the number 7 is `7`. | The file no longer holds the zeros. |

## Limits (provisional)

- **50 MiB** per `.xlsx` file, checked before reading.
- **512 MiB** unpacked: the zip's central directory is read first and the file is
  rejected if its entries add up to more, so a zip bomb never reaches SheetJS.
- The **6,000,000-field** limit applies as for CSV.

These caps are guesses until the benchmark gains an `.xlsx` case; a workbook holds
far more bytes per cell in memory than CSV.

## Later

- Profiles remembering the sheet name.
- A "header on row N" setting.
- An `.xlsx` benchmark scenario, then real limits.

## Explicitly skipped

- `.xls`, `.xlsb`, `.ods`, password-protected workbooks.
- Raw (unformatted) cell values, recalculating formulas, comparing several sheets at once.
