# Browser and spreadsheet verification

Verified 2026-10-06 against application snapshot `83d8fcd`.
This is observed behavior, not a declaration that every browser or input is supported.
The [implementation spec](v1-implementation-spec.md) remains the behavior reference;
the [original build plan](build-plan.md) is unchanged.

## Environment and scope

| Item | Recorded condition |
| --- | --- |
| Browser | Installed Google Chrome **154.0.8037.98**, headless, 1280 × 1000 viewport. |
| Hardware | Apple M4, model Mac16,12, **16 GiB RAM**. |
| OS | macOS **15.7.9**, build 24G830. |
| Application | Fresh production build served by `npm run preview` on `127.0.0.1:4173`; not the deployed GitHub Pages site. |
| Automation | Playwright with Chrome DevTools Protocol; isolated browser contexts and a dedicated temporary Chrome profile, not the user's Chrome profile. |
| Spreadsheet | Apple Numbers **14.4**, actual local CSV imports inspected through AppleScript. |
| Supporting checks | `npm test`: **146 tests passed in 10 files**. `npm run build`: TypeScript and production build passed. |

**Tested:** actual DOM controls, a real browser worker, localStorage, downloads,
rendered tables, browser reload and processing cancellation. Screenshots of the
known-file Problems tab and large-value results were also inspected.

**Not yet verified:** Safari/Firefox, other Chrome versions, mobile viewports,
keyboard/accessibility workflows, private mode, the deployed site, Excel or
LibreOffice. No lint run was made as part of this verification.

The automation harness, raw measurement JSON, screenshots, known input files and
small downloads are retained in session artifacts under `files/browser-verification/`.
The harness is not a committed repository E2E suite. Temporary large inputs,
large downloads and the dedicated Chrome profile are cleaned up after inspection.

## 1. Known files, rules, tabs and filtering

**Tested:** an eight-record old file and seven-record new file, each with five
columns: `warehouse,sku,price,name,note`. The selected composite key was
`(warehouse, sku)`, with default key trimming. `price` was numeric with tolerance
`0.01`; `name` used case-insensitive value comparison.

The pair deliberately included:

- A note changing from `old` to `=1+1`, while `1.00` → `1.01` remained within tolerance.
- Case-only name changes that did not count as changes under the selected rule.
- One added and one removed record.
- A key duplicated twice in old and once in new, excluded on both sides.
- An empty key component in each file.
- `N/A` on both sides of a numeric field: unchanged text, two warnings.

| Checked result | Observed |
| --- | --- |
| Summary | **1 added, 1 removed, 1 changed, 3 unchanged, 1 ambiguous key, 2 empty-key records**. |
| Column summary | `note: 1`; no price or name changes. |
| Added / Removed | Correct record contents, including `00123` and the removed name. |
| Changed filter | Selecting `note` retained the expected changed record. |
| Problems | Three ambiguous members, two empty-key records, two numeric warnings, including their data-record locations. |
| Browser failures/network | No uncaught page errors or off-origin page requests observed across the successful browser runs. |

The network observation is scoped to recorded page requests in these workflows;
it is not a comprehensive network or privacy audit.

## 2. Saved-profile reproduction

**Tested:** save the active rules as `Browser verification`, reload the browser
page, select the stored profile, Apply, reload the same files and Compare.

The profile survived the page reload in real localStorage. The resulting rules,
all six counts, numeric-warning count and changed-column summary matched the
original comparison. Files still needed to be supplied again; profiles did not
persist their contents.

**Not yet verified:** closing/relaunching Chrome, private-mode persistence,
cross-tab updates, actual profile-file import/export controls and deletion UX.
Module tests cover additional profile validation and storage cases, but those
are separate evidence.

## 3. Downloads and actual spreadsheet behavior

**Tested browser downloads:** the protected changes CSV, an unprotected CSV and
the JSON report were downloaded through the UI, saved and inspected.

- CSV had a UTF-8 BOM, five expected columns and **11 data rows**: five added
  fields, five removed fields and one changed field.
- The composite key remained one quoted JSON-array cell.
- Protection changed `=1+1` to `'=1+1` in CSV. Disabling protection preserved
  `=1+1`; `-12` remained a plain signed number.
- JSON retained the original formula text, selected rules, correct counts,
  complete duplicate members and both numeric warnings.
- Every generated large CSV was checked against its expected field-row count.
  Every large JSON download was parsed and checked against the generator's
  added/removed/changed/unchanged counts and record-array lengths.

**Tested in Numbers 14.4:** both downloaded CSV variants imported as a
**12-row × 5-column** table, including the header.

| CSV content | Protected import | Unprotected import |
| --- | --- | --- |
| Composite key `["w1","004"]` | Text, unchanged; no formula. | Text, unchanged; no formula. |
| Added SKU value `004` | Number displayed as `4`. | Number displayed as `4`. |
| Added note value `00123` | Number displayed as `123`. | Number displayed as `123`. |
| Signed decimal `-12` | Number displayed as `-12`. | Number displayed as `-12`. |
| Changed note `=1+1` | Literal text `'=1+1`; no formula. The apostrophe remains visible. | Formula `=1+1`, calculated value **2**. |

**Observed limitation:** CSV preserves the original strings, but Numbers'
automatic type inference does not preserve leading zeros in ordinary value
cells. This is a spreadsheet-import behavior, not a change to engine or JSON data.
Use an import workflow that explicitly preserves text, or the JSON report, when
exact string identity matters. Such a text-import workflow was not verified here.

**Not yet verified:** Excel/LibreOffice, every formula prefix, whitespace/LF
interpretations, locale-sensitive number/date conversion and giant spreadsheet
imports. This arithmetic example establishes the tested protection behavior,
not universal formula safety.

Numbers initially opened no document while setup/access was unresolved.
Following user-enabled setup/access, the actual imports above succeeded. Only
synthetic verification documents were inspected and closed.

## 4. Cancellation and explicit recovery

**Tested:** 150,000 old records with **31 total columns**, 12-character value
fields, nominal 90% changes, seed 42 and nominal 2% additions/removals.

Cancellation was exercised during file processing and during the indexing phase
of a comparison. The checks established:

1. The active worker was terminated; activity disappeared.
2. No new requests or automatic reread started during a one-second observation.
3. Loaded/interrupted files showed explicit `Read <file> again` recovery controls.
4. Clicking those controls created a fresh worker and reread the files.
5. Recomparison matched the known answer: **3,000 added, 2,989 removed,
   135,145 changed, 11,866 unchanged**.
6. Picking the same file through its file input again started a new parse.

The combined cancellation/recovery workflow created three workers and terminated
two before successful recovery.

**Not yet verified:** cancelling an export, cancellation at every phase boundary,
worker crashes in a real browser, or all combinations of simultaneously active tasks.

## 5. Larger comparisons through scrolling and export

### Method

All B1–B10 measurements below use the **Chrome 154.0.8037.98 / Apple M4 /
16 GiB / macOS 15.7.9 environment above**. Each case had a fresh browser context;
browser processes were reused within a run. Each scenario has **one successful
sample**, not a repeated distribution. Tests/build were not running concurrently.

Inputs came from `scripts/bench/generate.ts`, seed 42. Columns include the `id`
key; field length describes each value field, not the varying-width numeric ID.
Ratios are fractions of old records. B1–B7 and B9 requested 2% additions and
2% sampled removals; B8/B10 had neither, so both files could reach exactly
6,000,000 fields.

Each successful case performed real file loading, key selection, comparison,
25 sampled scroll positions from start to end, return to the start, changed-column
filtering, Added/Removed tab inspection and both downloads. This is not an
exhaustive sequential visit to every row; complete exports were inspected separately.

| Case | Old / new rows | Total columns | Value chars | Changed requested / actual | Old / new input MiB |
| --- | --- | ---: | ---: | --- | --- |
| B1 | 10,000 / 10,004 | 11 | 12 | 5% / 4.830% | 1.29 / 1.29 |
| B2 | 100,000 / 100,028 | 11 | 12 | 5% / 4.924% | 12.96 / 12.97 |
| B3 | 100,000 / 100,011 | 11 | 12 | 90% / 89.972% | 12.96 / 12.96 |
| B4 | 250,000 / 249,986 | 11 | 12 | 90% / 89.975% | 32.56 / 32.56 |
| B5 | 500,000 / 499,933 | 11 | 12 | 5% / 5.009% | 65.22 / 65.21 |
| B6 | 100,000 / 99,939 | 51 | 12 | 5% / 4.942% | 62.55 / 62.51 |
| B7 | 100,000 / 100,031 | 11 | 64 | 5% / 4.859% | 62.55 / 62.57 |
| B8 | 500,000 / 500,000 | 12 | 12 | 90% / 89.936% | 71.42 / 71.42 |
| B9 | 100,000 / 99,973 | 11 | 200 | 5% / 4.986% | 192.25 / 192.20 |
| B10 | 500,000 / 500,000 | 12 | 36 | 90% / 90.047% | 197.30 / 197.30 |

### Timings

Times are milliseconds observed at the UI/worker-message boundary:

- **Load wall:** supplying both files through browser-local file handles until
  both parses succeed and the schema is available.
- **Parse sum:** summed parse-request latencies, including reads, queueing and
  delivery. The requests overlap; this can exceed load wall time.
- **Index / compare:** approximate split of the comparison request at its first
  received compare-phase progress message, not isolated pure-engine timings.
- **Page max:** maximum `getRows` response latency in that case, including the
  first changed-column filter, transport and queueing.
- **CSV / JSON:** worker request completion time for Blob creation, before
  the browser finishes saving the download.

| Case, environment above | Load wall | Parse sum | Index / compare | Page max | CSV / JSON |
| --- | ---: | ---: | --- | ---: | --- |
| B1 | 84.1 | 66.5 | 15.4 / 2.4 | 16.0 | 17.8 / 16.9 |
| B2 | 332.7 | 441.0 | 107.6 / 33.5 | 15.5 | 43.7 / 18.3 |
| B3 | 322.4 | 445.2 | 111.6 / 44.7 | 19.9 | 123.7 / 66.9 |
| B4 | 770.5 | 1,108.6 | 349.2 / 116.8 | 43.9 | 361.9 / 215.4 |
| B5 | 1,732.0 | 2,508.7 | 1,093.8 / 152.8 | 16.2 | 226.2 / 84.6 |
| B6 | 1,094.8 | 1,566.9 | 261.3 / 147.6 | 18.8 | 188.2 / 37.0 |
| B7 | 423.0 | 592.2 | 81.3 / 68.1 | 15.3 | 59.7 / 26.5 |
| B8 | 1,973.5 | 2,910.3 | 1,188.2 / 240.6 | 63.4 | 507.2 / 452.0 |
| B9 | 1,139.4 | 1,684.1 | 162.8 / 75.2 | 15.6 | 93.1 / 54.5 |
| B10 | 2,417.2 | 3,733.2 | 1,332.7 / 916.1 | 109.8 | 599.6 / 648.9 |

### Downloads, scrolling and memory

Download times include the browser download event and saving the file. Peak RSS
is the sampled sum for the dedicated Chrome process tree, including browser,
renderer and helpers. It is **not** the app's JS heap alone; shared mappings can
be counted more than once. Sampling every 200 ms can miss transient peaks.
Before loading, the Chrome tree measured approximately 995–1,043 MiB.

| Case | CSV / JSON MiB | CSV / JSON save ms | Sampled Chrome-tree peak MiB |
| --- | --- | --- | ---: |
| B1 | 0.15 / 0.18 | 57.7 / 64.6 | 1,162 |
| B2 | 1.58 / 1.88 | 93.5 / 54.9 | 1,338 |
| B3 | 5.32 / 15.40 | 185.1 / 148.8 | 1,368 |
| B4 | 13.49 / 39.10 | 477.1 / 452.2 | 1,621 |
| B5 | 8.12 / 9.65 | 334.5 / 147.2 | 1,988 |
| B6 | 6.95 / 5.48 | 266.1 / 79.0 | 1,939 |
| B7 | 4.03 / 4.32 | 117.0 / 79.1 | 1,544 |
| B8 | 20.14 / 73.03 | 660.9 / 727.2 | 2,170 |
| B9 | 10.61 / 10.91 | 189.9 / 364.8 | 1,746 |
| B10 | 40.77 / 93.73 | 774.5 / 992.1 | 2,552 |

**Observed scrolling:** the last result row remained reachable, with at most
34 rendered rows across these cases. Returning to the start refetched page zero
for B2–B10, consistent with cache eviction; B1 needed only three changed pages.
Variable-height rows in B9 needed an additional bottom-scroll after measurement
settled. The 1.57–2.48 s scroll checks include deliberate pauses and automation
overhead, so they are not scroll-throughput measurements.

A 50 ms main-thread heartbeat had a maximum observed interval of **169.2 ms**
across these cases. This checks that the page was not stalled for the entire
comparison; it does not demonstrate 60 fps or establish a responsiveness SLA.

For B10, the post-export worker sample contained approximately **899.8 MiB used
JS heap** plus **520.8 MiB backing storage**. No forced GC was performed, so this
is not a retained-memory minimum. The sampled Chrome-tree peak was about
**2.49 GiB**, including roughly 0.97 GiB of pre-load process-tree RSS.

### Practical envelope, not a universal supported maximum

**Tested on this machine/browser:** B10 completed with **500,000 rows × 12
columns per file**, exactly **6,000,000 fields**, approximately **197.30 MiB per
file**, and **450,235 changed records**. Comparison, scrolling/filtering, a
40.77 MiB CSV and a 93.73 MiB JSON download all completed and their counts matched.
This exercises the field cap and approaches the byte cap simultaneously.

That is the largest jointly stressed configuration here, not proof that all
inputs within the guardrails fit. B6 and B9 also demonstrate why row count or byte
size alone is not a useful universal limit.

**Supported-limit decision remains pending:** the existing 200 MiB / 6M-field
caps can remain provisional guardrails, but these single Chrome/M4 samples do
not justify advertising them as safe capacity across browsers/hardware.
Before doing so, repeat measurements, test lower-memory machines and other
engines, include numeric/diagnostics-heavy inputs and observe whole-pipeline
memory under concurrent browser workloads. Do not extrapolate beyond the measured
dimensions or raise the caps from these results alone.

## Findings and remaining uncertainty

- No application assertion failure or uncaught page error was found in the
  successful workflows and ten completed comparison/export cases.
- Numbers automatically converts ordinary zero-padded values to numbers.
  Composite-key JSON cells retain their original parts.
- Formula protection worked for the actual tested arithmetic example; switching
  it off caused execution in Numbers. Excel/LibreOffice remain unverified.
- Parse diagnostics still have no paging UI. Accessibility, cross-browser
  behavior, crash recovery and export cancellation need separate checks.
- Initial harness attempts required selector correction, browser-local CDP file
  selection to avoid Playwright's remote-transfer 50 MiB limit, and settling
  variable row heights before asserting the final row. Those harness failures
  are not evidence of an application data-loss bug.
