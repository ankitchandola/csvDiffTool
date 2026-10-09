# Reconcile usability pass: done and pending

Branch `feat/reconcile-group-review`, 2026-10-10. Goal: make Reconcile usable by people who did not build it. Verified so far with `npm test`, `npm run lint`, `npm run typecheck` and the full Playwright suite (`npm run test:ui`); not yet with a hands-on run of the six tasks below, a screen-reader pass or Firefox/Safari.

## Done (local commits, not pushed)

| Area | Change |
| --- | --- |
| Review layout | Experimental banner hidden on Review; session save state is one line, separate from the Reconciliation status; match metrics and accounting checks are collapsed; "What blocks completion" is the first line of the status panel. |
| Scrolling and focus | One page scroll (window virtualizer). A decision refetches the list in place and focus returns to the row now at that position, so the page no longer jumps. Tabs and search stay sticky. |
| Pair rows | Signed amount with a Money in/out label (not colour only); "N bank transactions ↔ M books transactions" chip; "Show N members" with date, amount, direction, description and source for each; consequence text for competing pairs; descriptions clamp to two lines; carried items show their file and period. |
| Actions | Confirm, Reject, Details sit in the same place; Reject and Unmatch carry titles saying what they do. |
| Keyboard | Visible shortcut bar per tab; shortcuts ignored inside inputs, selects, listboxes, tabs and dialogs; stronger focus outline. |
| Unmatched | "Only items not yet classified" filter (worker `unclassified` flag). |
| Map | Date column and format, amount layout and columns, references, description and running balance are detected from headers and first rows (`guess-mapping.ts`, tested on the Indian fixtures). Required fields first; the rest under "More options" with a summary of what is set. The mapping check runs by itself for files up to 20,000 records and shows under the forms. |
| Files | Header and skip settings folded into "Statement layout". |
| Select | Menu follows its trigger when the page scrolls and closes only when the trigger leaves the screen. Fixes menus with a preselected option closing themselves. |

## Pending

1. **Narrow screens.** Check Review and Map at 390px and 768px (sticky tabs, session line, status grid, pair rows). The existing "fits 390px" test only checks for horizontal overflow.
2. **Recovery messages.** After import, reload, resume or cancel, show one accurate next step and remove it once done. Today the notes are spread across the session bar, file panels and the Review step.
3. **Carried items in Unmatched.** The row card shows file and period; add a visible "Carried from <period>" chip and a way to filter to carried items, so an outstanding cheque's original period is obvious.
4. **Mapping preview side by side.** Bank and Books previews are stacked; put each under its own mapping column.
5. **Currency.** Still typed by hand. Could be suggested from a header such as "(INR )", but the files are not checked against it, so keep it explicit.
6. **Counts and units.** Tab counts say pairs for Suggested, matches for Confirmed, transactions for Unmatched. Check the Problems tab and the status reasons use the same units, and that "4 transactions" never means seven source rows.
7. **Competition detail.** The consequence line says confirming removes "the other suggestions that share either transaction". Name how many and which, from the group data, instead of the general sentence.
8. **Completion blockers.** The "Next:" line shows only the first unmet reason. Offer a link from it to the Unmatched tab filtered to unclassified items.
9. **Large files.** Mapping check on files over 20,000 records is still manual (button reads "Check mapping"). Measure whether a worker-side quick sample could preview sooner.
10. **Browsers and assistive technology.** Only Chrome is covered. Run `npm run test:ui:browsers`, and try the sticky tabs, the list region and the shortcut bar with a screen reader.

## Tasks to walk through by hand

1. Load an unfamiliar statement and correct its mapping.
2. Review a competing batch and say which members will be consumed.
3. Confirm, undo and pick a different match.
4. Classify an outstanding cheque and find its original period.
5. Reload, recover the session and read its save status.
6. Find what still prevents completion.

Record what fails in this file before fixing it.

## Notes for tests

- Optional sections (`details.optional-fields`) are collapsed for people. Reconcile specs import `test` from `e2e/reconcile-test.ts`, which opens them as they appear.
- The review list is virtualized against the page, so rows below the fold are not in the DOM. Tests search to bring a row into view.
- The accounting details (exports, balance bridge) are collapsed; use `openAccounting(page)` from `e2e/reconcile-helpers.ts`.
