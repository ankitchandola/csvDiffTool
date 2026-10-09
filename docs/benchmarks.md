# Benchmarks and size limits

Raw numbers: [`benchmark-results.md`](benchmark-results.md). Reproduce with
`npm run bench -- --write`.

## Method

`scripts/bench/generate.ts` builds old/new file pairs from a seeded random generator
with an exact, known number of added (2%), removed (2%) and changed records. Every
benchmark run checks the comparison's counts against that answer, so a performance
run is also a correctness run.

`scripts/bench/run.ts` drives the worker handler — the same code the browser worker
runs — through parse (both files), compare (key indexing, then value comparison),
paging (three `getRows` pages plus a filtered one), and both exports. It varies one
thing at a time from a base of 10 value columns, 12-character fields and 5% changed:
row count, column count, field length, and change ratio.

Memory is V8 heap plus external memory above a baseline taken once the two input
files exist. Peak is sampled at every progress report (each 2,048 records) and at the
end of each stage, so it is a lower bound. "Held" is what stays allocated after a
forced GC once the comparison is done: the parsed files plus the stored result.

Measured on an Apple M4 with 16 GB RAM, Node 24.15 (V8, 4,288 MB heap limit).

## Findings

| Input | Rows × cols per file | Input MB (both) | Parse + compare | Peak MB | Held MB |
| --- | --- | ---: | ---: | ---: | ---: |
| Base | 100,000 × 11 | 26 | 0.5 s | 209 | 140 |
| Base | 500,000 × 11 | 130 | 3.1 s | 1,004 | 806 |
| Base | 1,000,000 × 11 | 261 | 10.5 s | 1,907 | 1,615 |
| Short fields (4 chars) | 100,000 × 11 | 11 | 0.5 s | 146 | 79 |
| Long fields (64 chars) | 100,000 × 11 | 125 | 0.6 s | 324 | 162 |
| Wide | 100,000 × 51 | 125 | 1.6 s | 993 | 836 |

- **Memory follows the number of fields, not file size.** The same 125 MB of input
  peaks at 324 MB as long fields and at 993 MB as many short ones. Across the runs,
  peak is roughly 90 bytes per field (both files together) plus about the size of the
  text. A byte limit alone can't bound memory: one-character fields would use about
  45× their file size.
- **Time is dominated by parsing and key indexing**, both roughly linear up to
  500,000 rows. Indexing grows faster beyond that (1.1 s at 500,000 rows, 3.8 s at
  1,000,000), most likely garbage-collection pressure from a million-entry key map.
- **Change ratio barely matters for comparison**, but it drives export size: at 90%
  changed, the JSON report is 39 MB against 3 MB at 1%.
- **Paging stays under 13 ms** in every scenario, so result tables remain responsive
  regardless of size.
- Very small runs are noisy: one held-memory figure is slightly negative, where GC
  freed memory that was part of the baseline.

## Limits

Two limits per file, in `src/engine/limits.ts`:

- **200 MiB**, checked from the file's size before it is read.
- **6,000,000 fields** (data records × columns), checked while parsing; parsing stops
  as soon as it is exceeded.

At the field limit, two files come to about 12 million fields, or roughly 1.1 GB peak
at the measured rate — about a quarter of V8's heap, leaving room for the page itself
and for machines with less memory. The base 1,000,000-row case (11 million fields per
file, 1.9 GB peak) completed here, but is over the limit on purpose.

These limits are provisional. The runs above call the worker handler directly in Node:
no message cloning, rendering or download. Two files each under the caps can still
exceed what a browser tab holds once export runs, so the caps stay provisional until
the whole pipeline is measured in a browser.

## Not measured

- Browsers other than V8-based ones. Safari (JavaScriptCore) and Firefox
  (SpiderMonkey) have different string and object layouts; the limits may need
  revisiting if either is a target.
- The browser itself: Node runs the same worker code and engine, but a real tab adds
  the page, the worker's own isolate and the browser's limits per tab.
- Machines with less than 16 GB of RAM.

## .xlsx

`npm run bench -- --only="<scenario>"` runs one scenario per process. Workbooks are
generated in a child process (`scripts/bench/write-xlsx.ts`) so SheetJS's writing
memory doesn't count, and the .xlsx caps are lifted so the runs can measure past
them. Cells are text, as in an export of IDs and codes; random 12-character values
compress poorly, so these files are larger than typical real exports of the same
shape. SheetJS reports no progress while reading, so the sampled peak misses the
read; **Max RSS** (the process's memory high-water mark) is the peak to use.

Apple M4, 16 GB RAM, Node v24.15.0. One sample each, Node only (no browser). Rows
marked *before* ran on the first reader, before it gained the one-row outline read
and bounded parsing; they were not rerun.

| Scenario | Rows per file | Columns | Per file: zipped / unpacked MiB | Parse ms (both) | Compare ms | Peak heap MB | Max RSS MB |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| CSV, for reference | 100,000 | 11 | 13 (text) | 288 | 52 | 208 | 505 |
| xlsx | 100,000 | 11 | 22.6 / 48.4 | 7,853 | 65 | 466 | 1,043 |
| xlsx, data sheet after 3 others of the same size | 100,000 | 11 | 90.5 / ~194 (4 × 48.4) | 11,841 | 60 | 573 | 1,806 |
| xlsx wide (*before*) | 100,000 | 51 | 102 / not measured | 32,349 | 233 | 2,077 | 2,423 |

### What is measured and what is chosen

| Limit | Value | Basis |
| --- | --- | --- |
| File size | 25 MiB | Chosen just above the measured base case (22.6 MiB per file, 1.04 GB peak for two files). Not measured at 25 MiB. |
| Declared unpacked size | 256 MiB | Chosen above the four-sheet case (about 194 MiB per file, 1.81 GB peak for two files). Not measured at 256 MiB. |
| Fields | 2,000,000 per file | Interpolated between the base case (1.1 million, 1.04 GB) and the wide case (5.1 million, 2.4 GB, old reader). Not measured at 2,000,000. |

Reading .xlsx is roughly 25× slower than CSV and peaks about twice as high for the
same data. Sheets that aren't compared still cost memory, which is why the byte caps
cover the whole workbook. Browser runs are a release check in
[`xlsx-spec.md`](xlsx-spec.md#release-checks).

## .xlsx export

The `XLSX ms (MB)` column of `npm run bench` (export caps lifted). Apple M4, 16 GB
RAM, Node v24.15.0, one sample each, each case in its own process, shared strings on.
Export memory is peak heap minus the held comparison; the export builds the whole
workbook in memory. Cell and character counts are computed from the generated shape.

| Scenario | Workbook cells | Characters | Export ms | File MB | Export memory MB | Max RSS MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 160,000 rows, 12-char values, 90% changed | ~941,000 | ~7.6M | 3,549 | 18.3 | 755 | 1,413 |
| same, 1-char values (repeated text) | ~941,000 | ~3.7M | 2,278 | 11.8 | 624 | 1,128 |
| 100,000 rows, unique 64-char values, 90% changed | ~588,000 | ~16M | 2,738 | 17.9 | 825 | 1,489 |
| 20,000 rows, unique 1,000-char values, 90% changed | ~118,000 | ~44M | 2,438 | 27.0 | 1,016 | 1,497 |
| 980,000 rows × 6 columns, 96% changed | ~5,700,000 | — | out of memory (4 GB heap) | — | — | — |

Fitting these gives roughly 580 bytes per cell plus 21 bytes per character (within
about 20%). The caps, 1,000,000 cells and 25,000,000 characters, put a result at both
at about 1.1 GB, near the 1,000-character case; the 44-million-character case itself
is over the text cap and would now be refused.

## Reconcile in the browser

`npm run build && npm run bench:reconcile` drives Reconcile in Chrome on a production
preview (`scripts/bench/reconcile-browser.ts`). Each case uses a fresh browser, two
generated CSVs with `date,amount` columns, exact amounts and the default ±3-day window.
It times the UI round trips: reading both files, "Check mapping", "Find suggestions"
until the first suggestion renders (normalization, candidate search, conflict groups,
sorting and the first page), and scrolling to the last page of suggestions.

Memory is the summed resident set size of Chrome's processes, sampled every 50 ms,
above a baseline taken after the mapping check. It covers the whole browser, not only
the worker, so unrelated processes move it, and sampling can miss short peaks. Treat
the ranges as rough evidence, not bounds.

Measured 2026-10-07, three runs per case, on an Apple M4 with 16 GB RAM, macOS, Chrome
154.0.8037.98, at 1440 × 900.

| Case | Rows per side | Candidate pairs | Groups | Search | Find suggestions | Last page | Peak above baseline |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| One amount, one day | 1,000 | 1,000,000 | 1 | complete | 0.4 s | 0.2–0.4 s | 77–163 MiB |
| One amount, one day | 1,414 | 1,999,396 | 1 | complete | 0.8–1.0 s | 0.4–0.8 s | 200–352 MiB |
| One amount, one day | 3,000 | 2,000,000 | 1 | budget reached | 0.9 s | 0.4 s | 104–358 MiB |
| One amount, one day | 20,000 | 2,000,000 | 1 | budget reached | 0.9 s | 0.4 s | 160–290 MiB |
| 500 amounts over 30 days | 50,000 | 1,112,000 | 500 | complete | 0.9 s | 0.2–0.4 s | 3–156 MiB |
| Distinct amounts | 200,000 | 200,000 | 200,000 | complete | 0.8–0.9 s | 0.04–0.05 s | 42–127 MiB |

- **The candidate budget bounds the work.** Past it, more rows (3,000 or 20,000 per
  side of one amount) cost no more time than the 2M-pair case: the search stops at the
  budget and reports itself incomplete.
- **At the budget, finding suggestions takes about one second** and holds roughly
  0.1–0.4 GiB above the browser's baseline on this machine. The 2,000,000-pair budget
  stays; it is now measured on one device rather than only chosen.
- **Not measured:** lower-memory laptops and phones, other browsers, worker heap
  separately from the rest of Chrome, and inputs near the file-size limits.

## Reconcile sessions in the browser

`npm run build && npm run bench:session` (`scripts/bench/reconcile-session.ts`) builds,
for N decisions, N bank and N books rows with distinct amounts and a session backup
confirming all N pairs, then in Chrome on a production preview: imports the backup,
loads the files and replays the history ("Find suggestions" until Confirmed shows N),
turns on saving in this browser (until "Saved in this browser"), makes five quick
decisions with saving on (until the last is saved), and exports a backup. Memory is
Chrome's process-tree resident size above a baseline, sampled every 50 ms: rough.

Measured 2026-10-08 on an Apple M4 with 16 GB RAM, Chrome 154.0.8037.98:

| Decisions | Session file | Backup | Import | Replay | Browser save | Five decisions, saved | Export | Peak above baseline |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0.6 MiB | 0.8 MiB | 0.1 s | 0.2 s | 0.1 s | 0.5 s | 0.2 s | 50 MiB |
| 10,000 | 6.0 MiB | 7.6 MiB | 0.9 s | 0.3 s | 0.1 s | 0.9 s | 0.3 s | 185 MiB |
| 50,000 | 30.2 MiB | 38.5 MiB | 4.3 s | 1.4 s | 0.2 s | 3.3 s | 1.4 s | 655 MiB |

- **Before two fixes, 50,000 decisions were slow:** five quick decisions took 45 s,
  a save 6.5 s and replay 3.2 s. The decision history list was redrawn whole, all
  50,000 entries, on every decision even while collapsed; it is now built only when
  opened and shows the latest 500. Saves while one is running now collapse into a
  single save of the newest revision.
- **A month's work is far below these sizes.** Hundreds to a few thousand decisions
  cost well under a second for every step.
- **Not measured:** lower-memory devices, other browsers, storage quotas near their
  limit, and sessions with large imported opening-item files.

## Reconcile worker requests in Node

`npm run bench:worker` (`scripts/bench/reconcile-worker.ts`) times each worker request
in Node, without a browser, so rendering and storage don't hide worker cost. Each side
has 200,000 rows with distinct amounts on 28 days. The bank side has a running balance
column, and both sides have stated balances.

Measured 2026-10-09 on an Apple M4 with 16 GB RAM, Node 24.15.0:

| Request | Time |
| --- | ---: |
| Read bank / books | 0.4 s / 0.3 s |
| Normalize | 0.4 s |
| Match | 0.4 s |
| Suggested, first page | 30 ms |
| Unmatched, first page (builds its index) | 0.25 s |
| Search, first (builds the text index) | 0.9 s |
| Search, later queries | 0.12 s |
| Status, first (builds totals and the running-balance check) | 0.42 s |
| Decide | 25–35 ms |
| Status after a decision | 7 ms (410 ms before this change) |
| Unmatched page after a decision | 37 ms |
| Outstanding-items export | 0.7 s |
| Report (JSON) | 1.6–2.6 s |

- **The status refresh after every decision was the main repeated cost.** It re-summed
  every amount, rebuilt a key for every unmatched transaction and re-walked the running
  balance on each call. Totals and the running-balance check now stay with the
  normalized data, and unclassified items are counted from the classifications. The
  browser session benchmark is unchanged, since its files have no balance column and
  its decisions are dominated by saving.
- **Index builds happen once per run.** Search and the Unmatched tab pay them on first
  use. Later searches are about 0.1 s, and the box waits 250 ms after typing before
  searching.
- **Exports are one-off and under 3 s at this size.** The .xlsx report refuses it
  (3.6 million cells against a 1 million limit) and points to the JSON report.

### Worker heap limits

The same benchmark in Node with a capped JavaScript heap (`node --max-old-space-size=N
--import tsx scripts/bench/reconcile-worker.ts --rows=R`). It is a stand-in for
lower-memory devices, not a measurement on one:

| Heap limit | 50,000 rows a side | 100,000 | 200,000 |
| --- | --- | --- | --- |
| 512 MiB | completes | out of memory | out of memory |
| 1 GiB | completes | completes | out of memory |

That is roughly 4–5 KiB of heap per row a side, from reading through the JSON report.
See `docs/reconcile-verification-2026-10-09.md`.
