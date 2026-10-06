# .xlsx results export

A third download beside the changes CSV and the JSON report: one `.xlsx` workbook
holding the whole result, a sheet per section. It exists because the CSV is awkward
in spreadsheets: Excel strips leading zeros when it opens a CSV, and formula-like
values need an apostrophe to stay safe. In an `.xlsx`, every value can be written as
a text cell, which keeps `0007` as `0007` and never runs `=SUM(A1)`.

This is not a file converter. CSV ↔ `.xlsx` conversion is out of scope (see
Explicitly skipped).

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Cell type | **Every cell is text**, numbers and dates included, exactly as compared. The Summary sheet says so. | The workbook shows what the comparison saw. Typing values would bring back the conversions this export exists to avoid (leading zeros, dates, long IDs turned into `1.23E+15`). The cost: spreadsheet maths needs a "convert to number" first. |
| Formula-like values | Written as plain text with no apostrophe. The "escape formulas" option applies to the CSV only and is hidden for `.xlsx`. | A text cell has no formula, so it is never evaluated and the original value can go in unchanged. |
| Text storage | Shared strings (`t="s"`, SheetJS `bookSST: true`). | By default SheetJS writes text as `t="str"`, the type of a formula's string result; shared strings are Excel's standard form for text. |
| Layout | One sheet per section (table below), not the CSV's single long table. | Each section has its own natural columns, and it covers the deferred "split the CSV into three files" request inside one file. |
| Composite keys | One column per key column, named after it (`Key: warehouse`, `Key: sku`), not a JSON array. | Filterable in a spreadsheet; covers the deferred "separate key columns" request. The CSV keeps its JSON-array key. |
| Key values shown | As written in the file (the same parts the CSV and JSON use); the JSON report remains the place with both old and new key parts. | Keeps the sheets narrow. |
| Library | SheetJS, already used in the worker for `.xlsx` input. It stays in a lazy chunk, loaded only for `.xlsx` input or export, so users who never touch `.xlsx` download nothing extra. Including the writer grew that chunk from 364 kB to 486 kB (minified). | No new dependency. |
| Styling | Column widths and an autofilter on each table's header row. No bold, colours or frozen panes. | SheetJS Community Edition doesn't write cell styles; widths and autofilters it does write. |
| Where it's built | In the worker, from the stored result, like the other exports. Built from the full result, never from the UI's pages. | Same rule as CSV and JSON: the export covers everything, not what was scrolled. |

## Sheets

| Sheet | One row per | Columns |
| --- | --- | --- |
| Summary | Fact | `Item`, `Value`: file names, generated at, counts, changes by column, the rules used (as JSON text), and the notes "all cells are text" and "record numbers count data records only". |
| Added | Added record | `Record` (new file), then every column of the new file |
| Removed | Removed record | `Record` (old file), then every column of the old file |
| Changed | Changed field | `Key: <col>` per key column, `Old record`, `New record`, `Column`, `Before`, `After` |
| Ambiguous keys | Record sharing a duplicated key | `Key: <col>` per key column, `File` (old/new), `Record` |
| Empty keys | Record left out for an empty key part | `Key: <col>` per key column, `File`, `Record` |
| Numeric warnings | Warning | `Column`, `File`, `Record`, `Message` |

Every sheet is present even when empty (headers only), so a reader can rely on the
layout. Sheet names are fixed English names, so file column names never become sheet
names.

## Limits

| Limit | Value | When exceeded |
| --- | --- | --- |
| Rows per sheet | 1,048,575 data rows (Excel's 1,048,576 minus the header) | The `.xlsx` export is refused with a message pointing to the CSV and JSON, which have no row limit. A sheet is never silently cut short. |
| Characters per cell | 32,767 (Excel's limit) | The export is refused, naming the sheet, column and record of the first long value. Excel would otherwise truncate or need to repair the file. |
| Cells in the workbook | 1,000,000 (provisional) | The export is refused with the same pointer to CSV and JSON. |

SheetJS Community Edition has no streaming `.xlsx` writer, so the workbook is built
whole in memory: about 0.9 KB per cell in the Node benchmarks
([`benchmarks.md`](benchmarks.md#xlsx-export)). A result near the sheet row limit
(about 5.7 million cells) ran out of a 4 GB heap, so in practice the cell cap, not
Excel's row limit, decides how large a result can be exported. The 1,000,000 cap was
chosen from those runs and then checked at about 940,000 cells. Results above it still
export as CSV and JSON. A writer that streams sheet XML into the zip would lift this
cap; it is listed under Later.

## Release checks

- [ ] Opens in Excel without a repair prompt; also opens in LibreOffice and Numbers.
- [ ] `0007`, a 16-digit ID, `2026-01-05`, `=SUM(A1)` and `-12` appear exactly as
  compared, as text, in Excel.
- [ ] Composite-key columns filter correctly; autofilters work on every sheet.
- [x] Node benchmark: export time and peak memory for large results (done; see
  [`benchmarks.md`](benchmarks.md#xlsx-export)). The case near the sheet row limit
  ran out of memory, which set the cell cap.
- [ ] Browser check of an export near the cell cap.
- [ ] Rows-per-sheet and characters-per-cell refusals tested with small injected limits.

## Later

- A streaming writer (sheet XML written row by row into the zip), to export results
  beyond the cell cap.

## Explicitly skipped

- CSV ↔ `.xlsx` conversion of input files.
- Typed cells (numbers, dates) and a "keep as numbers" option; revisit only on request.
- Cell styling, colours for added/removed/changed, frozen panes.
- Splitting an oversized sheet across several sheets.
- Unchanged records (as in the CSV).
