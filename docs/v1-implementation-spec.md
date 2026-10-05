# V1 implementation spec

Snapshot: `20ae403`, verified 2026-10-06. The [original build plan](build-plan.md)
remains the design record; this document describes the current implementation.

**Evidence labels apply independently:**

- **Implemented:** the behavior is present in this snapshot's source.
- **Tested:** the relevant automated checks passed in the verification below.
- **Not yet verified:** evidence is missing for that environment or interaction.
- **Not implemented:** the capability is absent, even if the build plan describes it.

Tests run in Node, not a real browser. An implemented feature with passing module
tests is not automatically a browser-verified user workflow. Historical benchmark
results are identified separately from measurements made for this document.

## Features

| What users can do now | Implemented | Tested | Not yet verified |
| --- | --- | --- | --- |
| Load two local CSVs, choose auto/comma/semicolon/tab delimiters, inspect the first 20 data records and schema differences. | File inputs, previews and schema display. | Parser, diff and handler tests. | Browser file selection, delimiter changes and network/privacy check. |
| Select single/composite keys and value rules; see added/removed/changed/unchanged counts and per-column change counts. | Rule forms, automatic key checks and comparison summary. | Classification and comparison tests. | Rule-form interactions and missing-key recovery in the browser. |
| Browse Added, Removed, Changed and Problems; filter changed records by column. | Virtualised, paged tables; Problems includes ambiguous records, empty keys and numeric warnings. | Handler filtering/paging and page-loader tests. | Rendering, scrolling, focus/keyboard behavior and accessibility. |
| Save/apply/delete profiles; import/export profile JSON. | Browser storage with a warned session-memory fallback. | Profile validation, round trips and storage doubles. | Real persistence, private mode and file-download/import UX. |
| Download changes CSV or a JSON report; observe progress and Cancel. | Export builders, download controls and worker termination. | Report/handler tests and mocked worker lifecycle tests. | Browser downloads, spreadsheet import and mid-task cancellation UX. |

**Deferred:** parse diagnostics beyond the first 20 are retained and accessible
through `getIssues`, but the UI does not page them; it shows the first 20 and states
the total ("showing 20 of N"), which is enough to fix the export and reload. Split CSV exports and
separate exported key columns are **not implemented**; the existing combined
long-format CSV is usable without them.

## Comparison rules

### Record identity and exclusions

**Implemented:** every selected key column must exist in both files.
Missing keys block comparison; the UI never silently reduces `(warehouse, sku)`
to `(sku)`. Key trim defaults ON; case-insensitivity defaults OFF. Normalisation
uses optional `trim()` followed by optional `toLowerCase()`, not fuzzy matching.
The ordered key parts are encoded with `JSON.stringify(normalisedParts)`, while
the original strings are retained for display and export.

Any empty component after normalisation excludes that record. If a key appears
more than once on either side, the entire key is ambiguous and excluded on
**both** sides. This includes collisions introduced by trim/case rules. An
old-once/new-twice key is not reported as an addition or removal.

Counts distinguish units: added/removed/changed/unchanged and empty-key counts are
records; ambiguous counts are distinct keys. The Problems UI also reports the
number of records belonging to ambiguous keys. Excluded records do not contribute
to added, removed, changed or unchanged counts.

**Tested:** reordered records, both duplicate-side cases, normalisation collisions,
empty composite components, separator-safe key encoding and leading zeros.
`0007` and `7` remain different keys; changing between them produces removal plus
addition. **Not yet verified:** the browser's missing-key warning/removal flow.
Optional empty key components are **not implemented**.

### Field equality and schema differences

**Implemented:** all parsed values remain strings. Only shared columns are
compared; old-only/new-only columns appear in the schema report, not as per-record
changes. Ignored columns are excluded completely, including their numeric
validation. Value trim and per-column case-insensitivity default OFF and are
independent of key rules.

For example, matching keys `abc` and `ABC` case-insensitively does not hide the
key field's case change when value rules remain exact. Likewise, non-key text
`0007` changing to `7` is a field change unless a numeric rule treats them equally.

**Tested:** these distinctions, schema-only columns, ignored invalid tolerances,
per-column case rules and prototype-named headers (`__proto__`, `constructor`).
**Not yet verified:** exhaustive combinations of rules and UI interactions.

### Numeric formats and tolerance

**Implemented:** numeric comparison is opt-in per column. Accepted plain decimal
forms include `1234.5`, `+7`, `-0.25`, `.5` and `3.`. Optional thousands stripping
accepts correctly grouped commas such as `1,234.50`, not `1,2` or `12,00`.
Exponents, decimal commas and blanks are not numbers. Surrounding spaces are
accepted only when the independent value-trim rule removes them.

Values are scaled `BigInt` decimals, not floating-point numbers. Tolerance is a
non-negative decimal string and is inclusive: `abs(before - after) <= tolerance`.
Thus `1.5` equals `1.50` at zero tolerance, and `1.00` equals `1.01` at `0.01`.
Invalid non-ignored tolerances reject comparison.

If either value is unparseable, comparison falls back to exact text equality
**after optional trim**, without numeric coercion or case folding. Each invalid
side produces a warning, including two warnings when both sides contain `N/A`;
identical invalid text can still leave a record unchanged.

**Tested:** decimal syntax, grouping, equivalent scales, inclusive boundaries,
negative/invalid tolerances and text fallback warnings.
**Not yet verified:** exhaustive locale and combined-rule cases.

## Architecture

### Worker ownership and result lifetime

**Implemented:** React uses a typed client that starts a module worker lazily.
The pure TypeScript engine parses, indexes and compares there. Files are read
into memory in full; this is not a streaming or disk-backed comparison engine.
The worker retains parsed files, full diagnostics and the latest diff.

Replacement parsing and recomparison invalidate the previous result. Each
successful comparison has a `resultId`; stale page/export requests are rejected
rather than receiving newer data. Startup, runtime and message-decoding failures
reject pending calls and surface an error. A subsequent call can start a fresh
worker, but the lost files must be reloaded. Unmount terminates the worker.

**Tested:** handler invalidation/stale-result checks; startup failures, worker
crashes and restart behavior using a fake worker.
**Not yet verified:** actual browser-worker construction, recovery and messaging.

### Paging and main-thread memory

**Implemented:** worker pages are capped at 500 items; the UI requests 200 and
renders virtualised rows. Changed-column filtering happens before paging and
updates the result total. It selects records, not just individual fields: the
matching record still carries all its field changes. Ambiguous groups are
flattened so every member can be paged, not just the preview's first ten.

The UI keeps at most 10 pages (2,000 rows) per table, evicting the pages farthest
from the visible range; scrolling back fetches them again. The worker holds the full
result, so a long scroll never copies a whole tab into the page.

**Tested:** stable page ordering, full-member coverage, filtering before paging,
page caps, stale-result rejection, loader request deduplication/errors and cache eviction.
**Not yet verified:** long-scroll browser memory, row sizing and visual layout.

### Progress and cancellation

**Implemented:** parse/index/compare/export send phase progress. Cancel terminates
the worker and rejects pending calls with `CancelledError`; it is not a pause or
rollback. Parsed files, results and worker diagnostics are lost. Nothing restarts
automatically: each file that was reading or read shows "Read <file> again", so
Cancel visibly stops work. Profiles stored outside the worker are unaffected.

**Tested:** progress routing and termination/rejection with a fake worker.
**Not yet verified:** real mid-task responsiveness, the explicit re-read, repeated
cancellation and recovery while multiple UI tasks are active.

### Profile storage

**Implemented:** profiles contain their name and separate parse/key/value rules.
Import/export uses versioned `csv-diff-profile` JSON with validation of fields
and rules. Storage uses `localStorage` key `csv-diff:profiles`; saving the same name
replaces that profile. Blocked/failed storage warns and falls back to session
memory. Import applies a profile but does not save it automatically.

Missing value-rule columns warn and have no effect; missing key columns block
comparison. Profiles do not store CSV contents or comparison results. Validation
only catches columns that are missing: it cannot detect a column whose meaning
changed while its name stayed the same. The rules used are shown with every result
and written into the JSON report so a reviewer can check them.

**Tested:** validation, JSON round trips, equivalent comparisons after applying
profiles, same-name replacement, persistence via storage doubles and fallback.
**Not yet verified:** real browser reload, private mode and cross-tab behavior.

## Export behavior

### Changes CSV

**Implemented:** UTF-8 with BOM, CRLF separators, header
`change_type,key,column,before,after`. Rows are ordered added, removed, changed.
Added records emit every new-file column under `after`; removed records emit every
old-file column under `before`. This includes ignored columns because these are
whole-record additions/removals. Changed records emit only the fields that changed.
Unchanged records, ambiguous keys, empty keys and warnings are not included.

A single-column key is its original string. A composite key is a JSON array
inside one correctly quoted CSV cell, not separate key columns. Changed rows use
the new record's original key parts. A tested layout example is:

```csv
change_type,key,column,before,after
changed,"[""w1"",""001""]",price,10,12
```

**Tested:** field layout, original/composite keys, quotes/commas/embedded newlines,
large-output chunking and handler Blob contents.
**Not yet verified:** spreadsheet interpretation of leading zeros, BOM and keys.

### Formula protection

**Implemented:** protection defaults ON and can be disabled per CSV export.
Cells beginning with `=`, `+`, `-`, `@`, tab or CR gain a leading apostrophe,
except plain signed decimals such as `-12`. The exact regex does not match LF
or whitespace-prefixed triggers. Protection changes only the exported CSV;
comparison values and JSON are unchanged.

**Tested:** listed prefixes, formula-like single keys, numeric exceptions,
opt-out and preservation of the comparison/JSON.
**Not yet verified:** Excel/LibreOffice execution behavior and protection against
all formula interpretations. This implementation is not a universal spreadsheet
safety guarantee, especially when protection is disabled.

### JSON and export memory

**Implemented:** the report has `format: "csv-diff-report"`, version 1, rules before
the data, old/new filenames, a generation timestamp, schema/count summary, all
added/removed records, changed fields with old/new keys and record numbers,
complete ambiguous groups, empty-key records and numeric warnings. Unchanged
records are not dumped. JSON preserves the original values without formula
escaping; diagnostic sections are not limited to the UI previews.

Both exports are built in the worker from roughly 1M-character chunks into a
Blob. Chunking avoids one giant output string but still retains the output in
memory; it is not streaming to disk. A table's changed-column filter does not
limit exports: exports use the full retained comparison.

**Tested:** report shape, filename/rules metadata, full diagnostic groups,
prototype-named fields and export immutability.
**Not yet verified:** large browser downloads and their peak memory.

## Limits and input diagnostics

**Implemented input handling:** strict UTF-8 decoding, BOM accepted, no encoding
detection. Empty/duplicate trimmed headers, structural errors and field-count
mismatches reject the file and block comparison. Diagnostics include offending
data-record numbers and raw text where applicable. Record numbers exclude the
header and skipped blank lines; a quoted newline does not create another record.

**Tested:** parser/handler fixtures, invalid-byte rejection, field mismatches,
embedded newlines and retained diagnostics. **Not yet verified:** representative
real-world exports across browser engines and export tools.

| Implemented preview/page limit | Retained data and access | Test evidence |
| --- | --- | --- |
| 20 file-preview records | Full valid file retained in the worker. | Handler preview test. |
| 20 parse issues | Full issue list retained; `getIssues` pages it, but the UI has no pager. | Retention/issue-page tests. |
| 50 ambiguous groups; 10 members per side within each preview group | Full group/member totals retained; Problems pages every member. | Group-cap and complete-member paging tests. |
| 50 empty-key records; 100 numeric warnings | Full lists retained and paged in Problems. | Preview totals and paging tests. |
| 500 items per worker page; UI requests 200 | Counts are not truncated; only response sizes are capped. | Handler page-cap and loader tests. |

**Implemented guardrails:** reject files above **209,715,200 bytes (200 MiB)** before
reading; abort parsing above **6,000,000 data records × header columns per file**.
Both constraints apply independently to each file. Field limits count data
records, not the header; byte limits are binary MiB and the UI labels them MiB.
Both caps are **provisional** until measured in a browser across the whole pipeline
(parse, compare, scroll, export).

**Tested:** enforcement at small injected thresholds, including acceptance exactly
at the field boundary. These are not tests of a full-sized browser comparison.
**Not yet verified:** safe supported browser/file limits. Capacity remains
**pending**; Node timings do not establish that two files at both caps, their
diagnostics and their exports fit safely in a browser tab.

## Verification and benchmarks

### Checks performed for this snapshot

| Command | Tested result | What it does not establish |
| --- | --- | --- |
| `npm test` | 145 tests passed in 10 files. | Browser/E2E behavior; client/storage tests use doubles. |
| `npm run build` | TypeScript compilation and production build passed. | Deployed-page behavior or successful downloads. |
| `npm run bench -- --quick` | Both scenarios completed; exact generated comparison counts matched. | Browser capacity, UI responsiveness or repeatable performance bounds. |

No lint run in this verification.

**Not yet verified, browser checks:** none performed here; no repository browser/E2E test suite.
Deployment, worker operation, scrolling, same-file reload, profile persistence,
downloads, progress/cancellation and spreadsheet import remain browser-unverified.

### Fresh Node benchmark measurements

**Tested:** one sample per case, no warmup/repetition; tests
and build ran concurrently, so these are noisy smoke measurements, not capacity
evidence. Seed 42; 2% additions, nominal 2% sampled removals; one value field
changed per selected record. Columns include `id`; field length applies to value
fields. Ratios below are requested/actual fractions of old records.

| Old/new rows | Columns | Field chars | Changed | Browser/runtime; hardware | Parse/index/compare/page ms | CSV/JSON ms | Peak/held MiB |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| 10,000 / 10,004 | 11 | 12 | 5% / 4.83% | No browser; Node 24.15.0; Apple M4, 16 GiB RAM | 194 / 124 / 28.0 / 11.5 | 34.7 / 8.5 | 34.1 / 14.4 |
| 10,000 / 9,980 | 11 | 12 | 90% / 90.01% | No browser; Node 24.15.0; Apple M4, 16 GiB RAM | 67.7 / 34.7 / 29.6 / 1.4 | 42.4 / 25.1 | 39.7 / 16.0 |

The checked counts were:

| Requested changed ratio | Added | Removed | Changed | Unchanged |
| --- | ---: | ---: | ---: | ---: |
| 5% | 200 | 196 | 483 | 9,321 |
| 90% | 200 | 220 | 9,001 | 779 |

Both inputs together were about 2.6 MiB; V8 heap limit was 4,288 MiB. The runner
calls the handler directly: no worker message cloning, browser rendering or actual
download. Parse covers both files; page timing covers four requests, including
one filter. Memory is heap plus external above an input-file baseline; sampled
peak is a lower bound, held memory follows forced GC after comparison.

### Historical measurements and capacity evidence

**Not yet verified for this snapshot:** the older [full results](benchmark-results.md) and
[method](benchmarks.md) record Node-only scenarios at 10k-1M old rows, 5/10/20/50
value columns **plus `id`**, 4/12/64-character values and 1/5/90% requested changes,
on Apple M4/16 GB/Node 24.15.0, with no browser. They are historical evidence,
not fresh validation of this snapshot or supported browser limits. Browser
measurements must identify browser/version, OS/hardware, old/new row counts,
total columns, field lengths, change/add/remove ratios, repeated stage timings
and peak memory. Include mostly-unchanged and mostly-changed cases, wide files,
long values, diagnostics-heavy inputs and exports before setting supported limits.

## Known gaps and deliberate exclusions

- **Implemented limitation, source-observed:** the full benchmark matrix includes 1M rows
  with 11 total columns, exceeding today's 6M-field guardrail; it cannot reproduce
  that historical scenario with the default handler limits. **Not yet verified:** full rerun.
- **Deferred:** parse diagnostics lack a paging UI (the first 20 and the total are
  shown). **Not yet verified:** UI memory in a real long scroll, and how spreadsheets
  treat the escaped CSV. Formula protection covers `=`, `+`, `-`, `@`, tab and carriage
  return; the UI copy says the same.
- **Tested:** earlier prototype-header, ignored-rule and worker-startup regressions
  have tests. **Implemented:** same-file selection clears the input. **Not yet verified:** browser regression
  checks; there is no claim that all bugs are resolved.
- **Not implemented, deliberately excluded:** JSON/nested input, column mapping,
  fuzzy matching, cleaning/editing, optional key components, accounts/backend/DB,
  Electron, split CSVs and separate exported key columns.
