# Deployed Reconcile check

Test date: 2026-10-07. Commit: `84aa1b59a80df1a8ae9f3f0c2b782e5a34d89121` (PR #2 merged to
`main`). Site: https://ankitchandola.github.io/csvDiffTool/, through the public UI, by the
project owner. Environment: desktop Chrome in a remote cloud browser, 1363 × 936 CSS-pixel
viewport. Chrome version, operating system, hardware and the exact input files were not
recorded.

## Passed

| Behavior | Observed |
| --- | --- |
| Date window | Inclusive ±3-day boundaries; asymmetric before/after bounds |
| Competition | Duplicate transactions show every competing pair |
| Exclusions | Opposite cash directions and conflicting shared references are not suggested |
| Normalization problems | Invalid dates, blank amounts, amounts with too many decimals and zero amounts stay out of matching |
| CSV and `.xlsx` | Separate money-in/money-out columns normalize the same from both formats |
| Layout | A multi-line CSV preamble keeps the original source line numbers |
| Blocking input | A missing mapped column and a missing `.xlsx` formula result block the input |
| Exact values | Large exact amounts and leading-zero references stay intact |
| Compare regression | One changed and one unchanged record; key `0007` preserved |

## Not verified in this run

- Candidate-budget exhaustion in the browser. The unit test uses a small injected
  budget; the 2,000,000-pair default has not been reached.
- Cancellation during Reconcile reading or matching. No automated test covers it either.
- Paging through large result sets.
- The 900 px no-scroll check for Compare results: it passes in the local Playwright
  suite (Chrome, 1440×900); this run's 1363 × 936 viewport is not that check.
- Other browsers, mobile and tablet widths, and touch input.
