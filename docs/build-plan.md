# CSV Diff Tool: Build Plan

Oct 5, 2026 · @Ankit

## Positioning and scope

A browser tool that compares recurring CSV exports by record identity, using saved rule profiles. The angle is not "another diff tool" but "set up the comparison once, rerun it on every new export." Files never leave the user's machine.

Example: compare yesterday's and today's product export by `sku`, ignore `updated_at`, allow ±0.01 on `price`, and get "12 added, 3 removed, 8 changed (price: 8, stock: 5)."

**In v1**

- Two CSV inputs, processed locally in a Web Worker
- Single or composite key selection
- Added, removed and changed records, with per-column change counts
- Ambiguous (duplicate) and empty keys reported, never guessed
- Separate key, value and parsing rules
- Saved profiles: save, apply, export and import as JSON
- Export: long-format changes CSV plus a JSON report that includes the rules used

**Out of v1**

- JSON input and nested data
- Column renaming or mapping between files
- Fuzzy matching, data cleaning or editing (OpenRefine's territory)
- Accounts, backend, database, Electron

**Stack:** React + TypeScript, Vite, Papa Parse, plain-TS comparison engine, Web Worker, static deployment.

## Comparison rules

Three separate rule sets, because matching a record and judging a change are different questions. Matching SKU `abc` with `ABC` must not hide a case change in `description`.

| Rule set | Controls | v1 defaults |
| --- | --- | --- |
| Parsing rules | How each file becomes records | Delimiter auto-detect (manual override), UTF-8, BOM stripped, headers trimmed |
| Key rules | Which records are the same entity | Trim ON and shown in the UI; case-insensitive off |
| Value rules | Whether two fields count as different | Everything off: no trim, no case folding, no numeric handling unless set per column |

**Keys**

- Composite key encoded as `JSON.stringify(normalisedParts)`. Collision-free, unlike a separator character that can occur in data.
- Original key parts are kept separately for display and export, e.g. `["warehouse-1", "00123"]`.
- Every key component must be non-empty after key normalisation, otherwise the record goes to the empty-key report. Keep this check isolated so it can become an option later (optional components such as an empty `variant` are common).
- Duplicates are detected after normalisation. If `ABC` and ` abc  ` collapse into one key, report it with the original values.

**Duplicates (ambiguous keys)**

If a key appears more than once in either file, it is excluded from comparison on both sides and reported as ambiguous. This covers both failure cases: old once / new twice, and old twice / new once. Excluding only one side produces false additions or removals.

**Values**

- All values stay strings (Papa Parse `dynamicTyping: false`), which protects leading zeros like `00123`.
- Ignored columns are skipped entirely.
- Numeric columns: optional thousands-separator stripping, then comparison as scaled `BigInt` at a common scale. Floats are wrong here: `1.01 - 1.00` is `0.010000000000000009`, which fails a 0.01 tolerance.
- Unparseable numeric values (`N/A`, blank) fall back to exact string comparison and add a numeric-validation warning. Never coerce to zero.

**Malformed input**

- Duplicate or empty headers (after trimming): reject the file. Papa Parse would otherwise rename them silently.
- Field-count mismatches and other structural errors: block comparison, and show the first offending records with their record numbers and raw text so the user can fix the export.
- Locations are reported as record numbers, not line numbers. A quoted field with a newline means record 10 need not start on line 10.
- Because incomplete rows are rejected, every record has every header, so `Record<string, string>` is accurate. Columns present in only one file are reported once in the schema diff, and only shared columns are compared.

## Architecture

The comparison engine is pure TypeScript with no React or DOM, runs inside a Web Worker, and keeps results there. React holds only the summary and the visible page of rows.

**Pipeline**

1. Parse and validate both files: headers, structure, record numbers.
2. Build a key index per side: normalised key → record indices.
3. Classify keys: empty, ambiguous, old-only (removed), new-only (added), matched.
4. Compare matched records using value rules.
5. Keep the result in the worker and serve it to the UI in pages.
6. Build exports in the worker as a `Blob` from chunks.

This needs both files indexed in full, but each file is read only once. Correctness comes before optimising reads; a two-pass streaming design is only worth it if measurements demand it.

**Folder layout**

```
src/
  engine/            # pure TS, fully unit-tested
    types.ts
    keys.ts          # key normalisation, encoding, classification
    values.ts        # value comparators, decimal tolerance
    compare.ts       # field diff for matched records
    report.ts        # export builders (CSV/JSON)
  worker/
    compare.worker.ts
    protocol.ts      # typed messages: parse, compare, getRows, export, progress
  profiles/          # save/load/validate rule sets
  ui/                # React components
```

**Profile types**

```ts
interface ParseRules {
  delimiter: 'auto' | ',' | ';' | '\t';
  trimHeaders: true;                 // v1: fixed, visible
}

interface KeyRules {
  columns: string[];
  trim: boolean;                     // default ON, shown in UI
  caseInsensitive: boolean;          // default off
}

interface ValueRules {
  ignoredColumns: string[];
  trim: boolean;                     // default off
  caseInsensitive: string[];         // per column
  numeric: Record<string, {
    tolerance: string;               // decimal string, compared via scaled BigInt
    stripThousandsSeparator: boolean;
  }>;
}

interface CompareProfile {
  name: string;
  parse: ParseRules;
  key: KeyRules;
  value: ValueRules;
}
```

**Result types (held in the worker)**

```ts
type Row = Record<string, string>;   // valid because incomplete rows are rejected

interface KeyRef {
  encoded: string;                   // JSON.stringify(normalisedParts)
  parts: string[];                   // original values, for display/export
}

interface FieldChange { column: string; before: string; after: string }

interface CompareSummary {
  schema: { added: string[]; removed: string[]; shared: string[] };
  counts: { added: number; removed: number; changed: number;
            unchanged: number; ambiguous: number; emptyKey: number };
  changesByColumn: Record<string, number>;
  warnings: { column: string; recordNumber: number; message: string }[];
  rulesUsed: CompareProfile;
}
```

The UI requests rows with `getRows(tab, offset, limit)`; it never receives the full result set. Virtualisation (TanStack Virtual) limits rendered elements, but worker-side paging is what limits memory on the main thread.

## Milestones

Ten milestones, in order. The worker exists from milestone 1 so parsing never runs on the main thread, and profiles land right after value rules work. Milestones 3–4 carry the core value, so write their fixture tests before the UI.

- [ ] **0. Scaffold.** Vite + React + TS + Vitest, empty engine module with a passing test, deployed to a static host on day one. *(Done except the deploy.)*
- [x] **1. Read one file in a worker.** Shows columns, record count, first 20 records, and structural errors by record number. Duplicate or empty headers are rejected.
- [x] **2. Read both files.** Schema diff (added, removed, shared columns), key column selection, ambiguous and empty key report before comparison.
- [x] **3. Key classification engine.** Added, removed, matched, ambiguous and empty keys are correct across fixtures, including both duplicate cases and normalisation collisions. Tested without UI.
- [x] **4. Value comparison.** Ignored columns, per-column case rules, decimal tolerance via scaled BigInt, numeric-validation warnings. Summary reads like "12 added, 3 removed, 8 changed (price: 8, stock: 5)."
- [x] **5. Thin profiles.** Save, load and apply a profile; export and import as JSON; warn when a profile's columns are missing from the new files.
- [x] **6. Results paging.** Worker serves pages via `getRows`; Added / Removed / Changed / Problems tabs with virtualised tables; filter changed records by column.
- [x] **7. Progress and cancellation.** Progress bar per phase; Cancel terminates the worker; UI stays responsive on a large test file.
- [x] **8. Export.** Built in the worker: long-format changes CSV (`change_type, key, column, before, after`) and a JSON report whose header lists the rules used.
- [x] **9. Benchmarks and limits.** Measure mostly-unchanged and mostly-changed inputs at several row counts and column widths, then set a documented size limit with a clear failure message.

## Deferred export improvements

Usability only; the current single long-format CSV is within the plan. Revisit if
realistic exports show its size is inconvenient.

- **Split CSV export** into three files, all with formula escaping:

  | File | Layout |
  | --- | --- |
  | `added.csv` | One row per added record, with all new-file columns |
  | `removed.csv` | One row per removed record, with all old-file columns |
  | `changed.csv` | One row per changed field: `key, column, before, after` |

- **Separate key columns** (`key_warehouse, key_sku`) instead of one JSON-array `key`
  column, for easier filtering in Excel.

## Testing

The engine is pure, so test it heavily with small fixture pairs and measure memory across the whole pipeline, not just parsing.

**Fixture pairs (`fixtures/`), one per case**

- Reordered records, identical content
- Key once in old, twice in new; twice in old, once in new
- Normalisation collision (`ABC` vs ` abc  `)
- Composite key with an empty component
- Leading zeros (`00123`)
- `1.5` vs `1.50`; `1,200` vs `1200`; `N/A` in a numeric column
- Tolerance boundary (`1.00` vs `1.01` at tolerance 0.01)
- Quoted field with an embedded newline
- BOM, semicolon delimiter, header with trailing space
- Duplicate header, empty header, field-count mismatch
- Column added and column removed

**Benchmarks**

A generator script produces file pairs with a known number of additions, removals and changes, so performance runs also check correctness. Vary three things independently: row count, column count and field length, and change ratio (mostly unchanged vs mostly changed). Track peak memory and time at each stage: parse, index, compare, page, export.

No size estimate goes into the docs or the UI until it comes from these measurements.

## Risks and success criteria

| Risk | Mitigation |
| --- | --- |
| Becoming a generic diff tool | Profiles and per-column summaries ship in v1, not later |
| Memory across the pipeline | Results stay in the worker, paged to UI; exports built in chunks; limits set from benchmarks |
| Over-normalising hides real changes | Value rules default off; every rule used is printed in the report header |
| Silently repairing bad input | Duplicate/empty headers rejected; structural errors block comparison with actionable record numbers |
| Profile drift (column meaning changes) | Profiles validated against new files; rules shown with every result |
| Scope creep into cleaning | No editing or transformation features |
| Assuming Electron fixes memory | It only raises the ceiling; real relief needs a different storage strategy (disk-backed or DuckDB-WASM) |

**Success criteria**

- **First usefulness check:** one real comparison of a recurring export (e.g. vendor master or ledger dumps from two dates) is faster and clearer than the Excel VLOOKUP routine.
- **Positioning validated:** the same saved profile is reused on the next export without changing any settings.
