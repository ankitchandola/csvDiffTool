# Reconcile verification gaps (2026-10-09)

The checks below closed the gaps left open after milestone 4: running out of storage,
typing dates month first, cancelling during matching, other browsers, lower-memory
devices and a deployed recheck. Everything was run with Playwright 1.63 on an Apple M4
with 16 GB RAM and macOS. The browsers were Chrome 154, Playwright's Firefox, and WebKit
26.6 (Safari's engine).

## Storage running out

Chrome's own quota for the page was shrunk through the DevTools protocol
(`Storage.overrideQuotaForOrigin`), so a save failed the way a full disk makes it fail.

- **Found:** the save status read "Not saved:  ·" with nothing after it. Chrome reports a
  full quota as an aborted transaction whose error has no message. The deployed site
  shows this too.
- **Fixed:** a quota failure now reads "This browser's storage for the page is full",
  however it arrives. Other storage errors fall back to their name, so none is shown
  blank.
- **Recovery:** once the quota was restored, the next decision saved, and the session
  resumed after a reload with both decisions.
- This is Chrome only. Firefox and WebKit offer no way for a test to shrink the quota.

## Dates typed month first

- **A date field's order comes from the browser, not the page.** Chrome on macOS follows
  the system region; Firefox and WebKit follow their own language. Playwright's locale
  setting doesn't change it, and Chrome on macOS ignores `--lang`.
- **The old day-first test only passed because this Mac's region is India.** The test
  now finds the order on a scratch date field and types the period that way.
- **Results:** Chrome here types day first; Firefox and WebKit type month first. All three
  store the same ISO dates and flag a reversed period.
- **Safari needs the separators** typed (`09/01/2026`). Digits alone leave the field empty.

## Cancelling while suggestions are found

Matching 600,000 transactions a side runs long enough to press Cancel once "Finding
suggestions" shows. The test cancels at that point.

- The work stops and both files ask to be read again.
- Review stays unavailable until a new search.
- Finding suggestions again completes with all 600,000 pairs.
- It passed in all three browsers, and 4 of 4 repeats in Chrome.

## Firefox and WebKit

`npm run test:ui:browsers` runs the whole suite in Chrome, Firefox and WebKit.

- **Result:** 151 passed, 2 skipped (the Chrome-only quota test), and 4 failed under load.
- **The 4 failures were cancel and save tests** running while three browsers read
  600,000-row files at once. In WebKit the work sometimes finished before Cancel was
  pressed. Each passed when run alone; the two Firefox ones were run twice.
- **Clipboard:** only Chromium lets a test grant clipboard access and read it back, so
  Firefox and WebKit check the "Copied" status but not the clipboard contents.
- **No Firefox- or WebKit-specific product bug was found.**

## Lower-memory devices

There is no phone in this setup. As a stand-in, `npm run bench:worker` ran the worker
code in Node with a capped JavaScript heap, covering reading through the JSON report:

| Heap limit | 50,000 rows a side | 100,000 | 200,000 |
| --- | --- | --- | --- |
| 512 MiB | completes | out of memory | out of memory |
| 1 GiB | completes | completes | out of memory |

That is roughly 4–5 KiB of heap per row a side. A phone browser that gives a worker
about 512 MiB would handle a month of a busy account (tens of thousands of rows), but
not the 200,000-row cases benchmarked on desktop. Real phone memory limits were not
measured.

## Deployed recheck

`BASE_URL=https://ankitchandola.github.io/csvDiffTool/ npx playwright test` ran the Chrome
suite against GitHub Pages after #24 deployed (deploy run 37848215049).

- **52 passed, including:**
  - the three Indian statement scenarios;
  - two-month carry-forward;
  - durability, cancel and the review flows.
- **2 failed:** the two storage-full tests. The deployed site predates the storage fix
  on this branch, and both show the blank message described above.

## Still not verified

- Real phones and tablets, and Safari itself as opposed to Playwright's WebKit.
- Storage running out in Firefox and Safari.
- Two real browser windows saving at once on separate profiles. The two-tab test uses one
  browser context.
