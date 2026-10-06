# .xlsx results export

A third download beside the changes CSV and the JSON report: one `.xlsx` workbook
holding every reported section of the result (unchanged records are left out, as in
the CSV), a sheet per section. It exists because the CSV is awkward
in spreadsheets: Excel strips leading zeros when it opens a CSV, and formula-like
values need an apostrophe to stay safe. In an `.xlsx`, every value can be written as
a text cell, which keeps `0007` as `0007` and never runs `=SUM(A1)`.

This is not a file converter. CSV ↔ `.xlsx` conversion is out of scope (see
Explicitly skipped).

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Cell type | **Every cell is text**, numbers and dates included: each file's original text, even where comparison rules trimmed it, ignored case or compared it as a number. The Summary sheet says so. | The workbook shows what the comparison saw. Typing values would bring back the conversions this export exists to avoid (leading zeros, dates, long IDs turned into `1.23E+15`). The cost: spreadsheet maths needs a "convert to number" first. |
| Formula-like values | Written as plain text with no apostrophe. The "escape formulas" option applies to the CSV only and is hidden for `.xlsx`. | A text cell has no formula, so it is never evaluated and the original value can go in unchanged. |
| Text storage | Shared strings (`t="s"`, SheetJS `bookSST: true`). | By default SheetJS writes text as `t="str"`, the type of a formula's string result; shared strings are Excel's standard form for text. SheetJS notes shared strings are slower and use more memory to write; the benchmarks below are with them on. |
| Text-safety invariant | Every cell is constructed fresh as `{ t: "s", v: text }`, including record numbers and Summary counts. Nothing is copied from input cell objects, so no cell can carry a formula (`f`), number type or format. Tests check the written XML has only shared-string cells and no `<f>` elements, then read values back and compare them exactly. | A copied cell could bring an input formula into the export. |
| Escapes in text | A literal `_xHHHH_` in a value is written as `_x005F_xHHHH_`, which Excel reads back as the literal text. Carriage returns and control characters are escaped by SheetJS (`_x000d_`, `_x0001_`). | Excel's format reads `_xHHHH_` as an escaped character, so `_x0041_` would otherwise open as `A`; an unescaped carriage return would be lost to XML line-end normalisation. |
| Excel's "number stored as text" indicators | Kept (SheetJS `ignoreEC: false`). | SheetJS documents that suppressing them can crash Excel in operations such as Text to Columns, which is how users convert these text cells. The green indicators are the accepted cost. |
| Layout | One sheet per section (table below), not the CSV's single long table. | Each section has its own natural columns, and it covers the deferred "split the CSV into three files" request inside one file. |
| Composite keys | One column per key column, named after it (`Key: warehouse`, `Key: sku`), not a JSON array. | Filterable in a spreadsheet; covers the deferred "separate key columns" request. The CSV keeps its JSON-array key. |
| Key values shown | As written in the file (the same parts the CSV and JSON use); the JSON report remains the place with both old and new key parts. | Keeps the sheets narrow. |
| Library | SheetJS, already used in the worker for `.xlsx` input. It stays in a lazy chunk, loaded only for `.xlsx` input or export, so users who neither import nor export `.xlsx` download nothing extra. Including the writer grew that chunk from 364 kB to 486 kB (minified). | No new dependency. |
| Styling | Column widths and an autofilter on each table's header row. No bold, colours or frozen panes. | SheetJS Community Edition doesn't write cell styles; widths and autofilters it does write. |
| Where it's built | In the worker, from the stored result, like the other exports: every reported section in full, never the UI's loaded pages. | Same rule as CSV and JSON: the export covers every reported record, not what was scrolled. |

## Sheets

| Sheet | One row per | Columns |
| --- | --- | --- |
| Summary | Fact | `Item`, `Value`: file names and, for `.xlsx` inputs, the compared worksheet names; generated at; counts; changes by column; the rules used (as JSON text); and notes that every cell is text, that values are each file's original text, that record numbers count data records only, and that unchanged records are not included. |
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
| Columns per sheet | 16,384 (Excel's limit), counting generated columns such as `Record` and the key columns | Refused the same way. A 16,384-column input can't fit Added or Removed, which add a `Record` column. |
| Characters per cell | 32,767 (Excel's limit), checked for headers and Summary values too | Refused, naming the cell address (`Added!C2`) and what it is: the column and record, the header, or the Summary item. Excel would otherwise truncate or need to repair the file. |
| Cells in the workbook | 1,000,000 (provisional) | Refused with the same pointer to CSV and JSON. |
| Characters of text in the workbook | 25,000,000 (provisional) | Refused the same way. A million short values and a million long ones cost very different amounts of memory, so cells alone can't bound it. |

Every limit is checked from the prepared rows before any SheetJS object is built, so a
refusal costs no workbook memory.

SheetJS Community Edition has no streaming `.xlsx` writer, so the workbook is built
whole in memory: about 580 bytes per cell plus 21 per character of text in the Node
benchmarks ([`benchmarks.md`](benchmarks.md#xlsx-export)), measured with repeated,
unique and long text. A result near the sheet row limit (about 5.7 million cells) ran
out of a 4 GB heap, so in practice these caps, not Excel's row limit, decide how large
a result can be exported. Both caps were chosen so that a result at both comes to
about 1.1 GB, near the largest export measured; neither was measured at its exact value. Results above it still
export as CSV and JSON. A writer that streams sheet XML into the zip would lift this
cap; it is listed under Later.

## Release checks

- [ ] Opens in Excel without a repair prompt; also opens in LibreOffice and Numbers.
- [ ] Text to Columns and "Convert to Number" work on exported number-like text in
  Excel, with the "number stored as text" indicators showing.
- [ ] `_x0041_`, a value with a carriage return, a leading apostrophe and emoji open in
  Excel exactly as compared.
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
