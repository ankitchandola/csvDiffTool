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

- **200 MB**, checked from the file's size before it is read.
- **6,000,000 fields** (data records × columns), checked while parsing; parsing stops
  as soon as it is exceeded.

At the field limit, two files come to about 12 million fields, or roughly 1.1 GB peak
at the measured rate — about a quarter of V8's heap, leaving room for the page itself
and for machines with less memory. The base 1,000,000-row case (11 million fields per
file, 1.9 GB peak) completed here, but is over the limit on purpose.

## Not measured

- Browsers other than V8-based ones. Safari (JavaScriptCore) and Firefox
  (SpiderMonkey) have different string and object layouts; the limits may need
  revisiting if either is a target.
- The browser itself: Node runs the same worker code and engine, but a real tab adds
  the page, the worker's own isolate and the browser's limits per tab.
- Machines with less than 16 GB of RAM.
