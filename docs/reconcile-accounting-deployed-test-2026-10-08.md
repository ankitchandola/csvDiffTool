# Deployed milestone 4 accounting check (assistant-run)

Reported 2026-10-08. Assistant-run browser check through the deployed site's public UI
in desktop Chrome in a remote cloud browser. The deployment commit was not
independently verified. Chrome version, operating system, hardware and the exact input
files were not recorded; the verification screenshot could not be attached.

No correctness blocker was found in the scenarios below. This is not a claim that every
milestone 4 case has been verified.

## Passed

- Opening balance plus movement equal to the closing balance validated the source.
- A ₹1 closing-balance error appeared as unexplained and blocked completion.
- A balanced bridge alone did not permit completion.
- Classifying outstanding items and explicitly marking complete worked.
- September's ₹30 outstanding cheque cleared in October without being counted again
  in October's books movement.
- October's export contained no outstanding items and kept the cheque's cleared lineage.
- Changing the matching rules withdrew completion.
- The JSON report reflected the results; the Excel report opened with text cells and
  no formulas.

## Qualification

Period dates typed through the browser's native date controls did not persist in this
browser, so the dates were supplied through synthetic session imports to finish the
accounting checks. The cause was not determined in this run.

Follow-up, local Chrome (Playwright, `en-IN`): dates typed day first into the period
fields stay set and survive leaving the step, so the app keeps typed dates. Clicking the
middle of a native date field puts the cursor in a later segment, which may explain the
remote run. The follow-up did find a real bug: a half-entered period was saved and made
the session backup impossible to import. Fixed: a period counts only once both dates are
entered and in order, and older backups holding a half-entered period read as none.

## Not verified in this run

- Overlapping carry-forward exports and re-importing already-cleared items.
- Liability-basis balances.
- Running-balance checks.
- The milestone 3 durability cases (covered by the local suite since PR #14, not on
  the deployed site).
