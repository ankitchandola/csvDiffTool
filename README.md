# CSV Diff

Compares two CSV exports by record identity, in the browser. Files are parsed and
compared in a Web Worker and never leave the machine.

Live: https://ankitchandola.github.io/csvDiffTool/ (deployed from `main` by GitHub Pages).

Plan and scope: [`docs/build-plan.md`](docs/build-plan.md).
Current behavior and verification: [`docs/v1-implementation-spec.md`](docs/v1-implementation-spec.md).
Browser measurements and spreadsheet observations: [`docs/browser-verification.md`](docs/browser-verification.md).

## UI redesign

The interface shows one step at a time: **Files → Match → Results**. Back keeps loaded files and rules; changing either invalidates the old result. The header uses the original purple lightning favicon as its brand icon, with matching purple controls on neutral surfaces. Help, profiles, previews and advanced options open on demand; dropdowns support keyboard and touch. Fonts and icons are bundled locally. See [`docs/ui-redesign.md`](docs/ui-redesign.md) for layout decisions and verification.

## Commands

```
npm run dev        # vite dev server
npm run build      # tsc -b && vite build
npm run lint       # oxlint
npm test           # vitest run
npm run test:ui    # Playwright browser checks (installed Google Chrome)
npm run typecheck  # tsc -b
```

`npm run test:ui` starts and stops a local Vite server on port 4175. Install Google
Chrome first, or run `npx playwright install chrome` after installing dependencies.
Browser test screenshots and failure traces are written to ignored `test-results/`.

## Layout

- `src/engine/` — pure TypeScript: parsing, key classification, value rules, diff. No React or DOM.
- `src/worker/` — the worker entry, its typed message protocol, and the client the UI calls.
- `src/ui/` — React components.
- `fixtures/<case>/{old,new}.csv` — one fixture pair per edge case, used by the engine tests.

## Input rules (v1)

- **Formats:** CSV/TSV/delimited text, or an `.xlsx` workbook on either side. For
  `.xlsx`, one sheet is compared (the first, or the one picked), using each cell's
  displayed text. This is designed to match the sheet's "CSV UTF-8" export for
  supported formats; verifying that against Excel-made files is a release check. `.xls`
  and password-protected workbooks are rejected. Details: [`docs/xlsx-spec.md`](docs/xlsx-spec.md).
- **Encoding (CSV):** UTF-8 only (a BOM is fine). Any other encoding is rejected with a
  message to re-export as UTF-8; there is no encoding detection.
- **Keys:** every key component must be non-empty after key normalisation. Records
  with an empty component are reported, not compared.
- **Numbers** (only in columns marked numeric): plain decimals such as `1234.5`,
  `-0.25`, `.5`, and trailing-minus negatives such as `1234.50-`. With the
  thousands-separator option on, comma grouping is accepted in Western
  (`1,234,567.5`) or Indian lakh/crore (`12,34,567.5`) style. Decimal commas, exponents and surrounding spaces are not numbers;
  those values are compared as text and reported as warnings.
- **Record numbers** count data records only: the header and skipped blank lines
  are not counted, and a quoted field spanning lines is still one record.

## Exports

- **Changes CSV** (UTF-8 with BOM, for Excel): `change_type, key, column, before, after`,
  one line per field. Added and removed records list every column of their file;
  changed records list only the fields that changed. A composite key is written as a
  JSON array of its parts. By default, values that a spreadsheet could run as a
  formula (starting with `=`, `+`, `-`, `@`, a tab or a carriage return) gain a
  leading `'`; plain signed numbers such as `-12` are left alone. This can be turned
  off per export. The comparison itself and the JSON report always keep the
  original values.
  Automatic spreadsheet import can still remove leading zeros from ordinary
  values: Numbers 14.4 imported `00123` as `123`. Composite-key JSON cells retained
  their parts; see the [spreadsheet checks](docs/browser-verification.md).
- **JSON report**: starts with the rules used, then the file names, the summary, and
  every added, removed and changed record, ambiguous key, empty key and warning.

## Size limits

Current guardrails reject files over **200 MiB** or **6,000,000 fields**
(data records × columns); `.xlsx` files at **25 MiB**, **256 MiB** declared unpacked
and **2,000,000 fields**, provisionally; these are chosen around [Node measurements](docs/benchmarks.md#xlsx), not measured at those values. Chrome 154 on an M4 / 16 GiB machine completed two
197.30 MiB files with 6,000,000 fields each through scrolling and both exports.
These are enforced caps and one measured configuration, not guaranteed capacity
across browsers/hardware. [Browser measurements](docs/browser-verification.md);
[Node measurements](docs/benchmarks.md). Generally supported limits remain pending.
