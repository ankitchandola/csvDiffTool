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
