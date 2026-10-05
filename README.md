# CSV Diff

Compares two CSV exports by record identity, in the browser. Files are parsed and
compared in a Web Worker and never leave the machine.

Plan and scope: [`docs/build-plan.md`](docs/build-plan.md).

## Commands

```
npm run dev        # vite dev server
npm run build      # tsc -b && vite build
npm run lint       # oxlint
npm test           # vitest run
npm run typecheck  # tsc -b
```

## Layout

- `src/engine/` — pure TypeScript: parsing, key classification, value rules, diff. No React or DOM.
- `src/worker/` — the worker entry, its typed message protocol, and the client the UI calls.
- `src/ui/` — React components.
- `fixtures/<case>/{old,new}.csv` — one fixture pair per edge case, used by the engine tests.

## Input rules (v1)

- **Encoding:** UTF-8 only (a BOM is fine). Any other encoding is rejected with a
  message to re-export as UTF-8; there is no encoding detection.
- **Keys:** every key component must be non-empty after key normalisation. Records
  with an empty component are reported, not compared.
- **Numbers** (only in columns marked numeric): plain decimals such as `1234.5`,
  `-0.25`, `.5`, optionally with comma thousands separators (`1,234.5`) when that
  option is on. Decimal commas, exponents and surrounding spaces are not numbers;
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
- **JSON report**: starts with the rules used, then the file names, the summary, and
  every added, removed and changed record, ambiguous key, empty key and warning.
