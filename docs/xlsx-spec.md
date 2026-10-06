# .xlsx input

Either side of a comparison can be an `.xlsx` workbook instead of a CSV. One
worksheet per file is compared, using each cell's **displayed text**. This is
designed to match a "CSV UTF-8" export of the same sheet for supported formats;
that match is a tested goal, not a guarantee (see Release checks). Everything after
reading (keys, rules, results, exports, profiles) is unchanged.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Formats | `.xlsx` only. `.xls` and password-protected workbooks (both OLE files) are rejected with a "save as .xlsx or CSV UTF-8" message. | `.xlsx` is what current tools write. |
| Library | SheetJS Community Edition 0.20.3, installed from the pinned official tarball on `cdn.sheetjs.com` (the npm `xlsx` package is stuck at 0.18.5 with known advisories) and bundled into a lazy worker chunk, loaded only when an `.xlsx` is read. | Supports Excel number-format rendering, and this is SheetJS's documented installation route. |
| Cell value | Displayed text, from SheetJS's formatted text for each cell: `1,234.50`, `2026-01-05`, `12%`. | Matches what users see and what a CSV export holds. Display rounding can hide a difference finer than the format shows. |
| Locale | SheetJS formats with its own rules, not the user's Excel locale. Locale-dependent formats (dates especially) may display differently from the user's Excel. | SheetJS can't know the locale the file was viewed in. |
| Numeric rules | Unchanged. Displayed text such as `₹1,234.50`, `$1,234.50` or `12%` is not a number to the numeric rules: it is compared as text and reported as a numeric warning, exactly as the same text in a CSV would be. `.xlsx` support adds no numeric conversions. | Keeps one numeric syntax for every input. |
| Leading zeros | Kept whenever the displayed text has them: a text cell `0007`, or the number 7 with number format `0000`. Lost only when neither the stored value nor its format contains them (the number 7 in General format reads `7`). | Displayed text carries the zeros a format adds. |
| Formulas | The result Excel last saved with the file. Nothing is recalculated. A saved result of `""`, `0` or `FALSE` is a value like any other (displayed as empty, `0` and `FALSE`). A formula cell with **no saved result at all** (no stored value) is a different case: it is reported as a problem (header or record) and the file is rejected until it is saved from Excel. It is never read as empty. | Reading a missing result as empty would report a change that isn't there; an empty-string result is a real value. |
| Sheet | A first one-row read gives the sheet names and the selected sheet's declared size; then only the selected worksheet is parsed into comparison records. The first sheet is used by default. A picker per file appears whenever there is more than one sheet, including when the selected sheet failed to load, so another can be chosen. Re-reads keep the selected sheet: after Cancel, after a worker failure, and after a delimiter change. | Most exports have one sheet. The rest of the workbook is still opened (shared strings, styles, other sheets' zip entries), so unread sheets still cost memory: see Limits. |
| Header | The first non-blank row of the worksheet's used range (the range the file declares). Blank rows above it are skipped. It need not be worksheet row 1. | Same rule as CSV, where blank lines before the header are skipped. |
| Short rows | Missing trailing cells are empty values. | Excel doesn't store empty cells; that is not an error, unlike a short CSV record. |
| Cells beyond the header | Reported as record problems and the file is rejected, like a CSV record with too many fields. Empty columns past the last header are ignored. | A value with no column name can't be compared. |
| Blank rows | Skipped and not counted, as in CSV. A row whose only content is an unsaved formula is not blank. | Same record numbering as CSV. |
| Merged cells, hidden rows/columns | Read as stored (a merge's value sits in its top-left cell; hidden rows count) and noted under the file. | Silent surprises are worse than a note. |

## Limits (provisional)

| Limit | Value | Checked |
| --- | --- | --- |
| File size | 25 MiB per `.xlsx` | Before reading |
| Declared unpacked size | 256 MiB | From the zip's central directory, before SheetJS runs |
| Fields | 2,000,000 per file (records × columns) | While parsing: see below |

These values are chosen around Node measurements, not measured at the values
themselves; [`benchmarks.md`](benchmarks.md#what-is-measured-and-what-is-chosen)
lists which number each one rests on. Every sheet in the file counts toward memory,
not just the compared one.

**How the field limit bounds parsing.** The first, one-row read gives the sheet's
declared range. The full read is then capped with SheetJS's `sheetRows` at the field
limit divided by the declared width (plus the header row), so SheetJS stops parsing
cells there. If the sheet declares more rows than that, the count is rechecked at the
header's real width (the declared width can include empty columns): over the limit,
the file is rejected without the full read; under it, the sheet is read in full.
Declared rows include blank rows, so a sheet with many blank rows can be rejected
slightly early. This bounds the cells SheetJS parses, not the memory for unzipping
the archive or its shared strings, which the byte caps cover.

**The unpacked-size check is a guardrail, not zip-bomb proof.** It sums the sizes the
archive *declares*. SheetJS's decompression is not bounded by those declarations, so
an archive that understates its sizes still reaches SheetJS. The backstop is the
worker: if it runs out of memory and dies, the UI reports the failure and the files
must be picked again; the page itself survives.

## Release checks

Before calling `.xlsx` supported:

- [ ] **Excel-generated pairs:** representative workbooks saved by Excel (number
  formats, dates, percentages, currency, text IDs with leading zeros, formulas), each
  compared against Excel's own "CSV UTF-8" export of the same sheet. Expected: no
  changes; any difference recorded here with its cause.
- [ ] **Browser benchmark:** at least one wide workbook and one multi-sheet workbook
  through parse, compare, scroll and both exports in a browser, to confirm or replace
  the Node-based caps above.

## Later

- Profiles remembering the sheet name.
- A "header on row N" setting.

## Explicitly skipped

- `.xls`, `.xlsb`, `.ods`, password-protected workbooks.
- Raw (unformatted) cell values, recalculating formulas, comparing several sheets at once.
- Locale-aware formatting.
