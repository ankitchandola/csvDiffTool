# Deployed milestone 3 review check (assistant-run)

Assistant-run deployed browser check, reported on 2026-10-08. Tested through the deployed UI in
desktop cloud Chrome at 1363 × 936. The deployment commit was not independently
verified. Exact input files, Chrome version, operating system and hardware were
not recorded in the supplied summary.

The core milestone 3 flow passed the scenarios below. No correctness blocker was
found in those scenarios; this is not a claim that all recovery and persistence
cases have been verified.

## Passed

- Confirm removes competing pairs sharing either transaction.
- Unmatch/reconfirm and reject/restore work.
- Autosave survives reload; matching source files restore decisions.
- Backup export/import restores decision history.
- Conflicting imports are rejected without changing active state.
- The same filename with different contents invalidates earlier decisions.
- Incompatible direction mappings remove active confirmations.
- Manual exceptions require reasons; opposite directions are blocked.
- Unequal identical sets preserve the reviewer's chosen unmatched row.
- Older backups cannot overwrite newer saved revisions.
- Confirmation shortcuts are ignored inside search fields.

## UI findings

Three messages needed correction:

- Clear the instruction to load the same files once recovery finishes.
- Correct the filtered confirmed-match count, which read "1 match match."
- Replace the claim that another tab saved the session with source-neutral wording
  about a saved revision. An older backup imported in the same tab can trigger
  the same storage conflict.

These findings describe the tested deployment. Subsequent local fixes and their
tests are not evidence that the deployed site contains those fixes.

## Not verified in this deployed run

- Quota failures.
- Actual simultaneous tabs.
- Cancellation recovery.
- Large sessions.

Local automated coverage, where present, is separate evidence and does not close
these deployed-run gaps.
