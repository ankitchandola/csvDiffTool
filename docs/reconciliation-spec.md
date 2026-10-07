# Reconciliation: product spec and implementation plan

Status: milestones 0-2 implemented as an experimental, suggestion-only mode on
`main` (`84aa1b5`, PR #2); milestones 3-6 proposed. See
[Implementation status](#15-implementation-status-milestones-0-2).  
Date: 2026-10-07.

This document defines a new reconciliation mode alongside the existing comparison
tool. Apart from section 15, it is a specification, not evidence that a feature
has shipped or passed verification.

## 1. Purpose and product boundaries

Comparison answers: "What changed between two exports that share a record key?"

Reconciliation answers: "Which transactions on these two sources represent the
same movement of money, and what remains unexplained?"

Bank statements and books may have different identifiers, dates, descriptions,
sign conventions and transaction groupings. Reconciliation therefore needs
independent source mappings, candidate generation, conflict resolution, human
decisions and accounting checks. It must not weaken the current comparison rules
to simulate these capabilities.

The application will offer two separate modes:

- **Compare:** retain existing input, key, value, profile and export behavior.
- **Reconcile:** normalize transactions, suggest pairings, review decisions and
  account for outstanding items.

The initial reconciliation release targets one account and one currency per
session. It remains browser-local, worker-backed and statically deployable.
No accounts, backend or bank connections are required.

### Scope

| Stage | Included |
| --- | --- |
| Initial matching milestone | Independent mappings, normalization preview, conservative 1:1 suggestions, ambiguity and input diagnostics |
| Initial usable release | Confirm/reject/unmatch, explicit manual 1:1 pairing, bulk confirm of interchangeable sets, session save/load, balance checks, outstanding-item export/import, reconciliation reports |
| Subsequent release | Grouping by a mapped payout or batch ID; then opt-in bounded 1:N and N:1 subset search; description similarity as a ranking signal within a tier |
| Deferred | N:M matching, partial allocations, mixed-currency sessions, FX conversion, automatic fee/write-off adjustments, fee netting across directions, percentage confidence scores, source-data editing, cloud sync |

Carry-forward and balance checks are part of the usable monthly workflow, not
prerequisites for testing the first matching engine.

### Naming

`LedgerLens` is a working name only. Check trademark, domain and repository
availability before adopting it. Rename the public product when a usable
reconciliation release ships, with clearly labeled Compare and Reconcile modes.
Repository/domain changes are separate deployment tasks; retain old URLs or
provide an explicit migration path. The existing lightning artwork can remain.

## 2. Relationship to existing documentation

| Document | Contract or evidence to retain |
| --- | --- |
| [Original build plan](build-plan.md) | Historical comparison scope; mapping and fuzzy matching were explicitly excluded from v1 |
| [V1 implementation spec](v1-implementation-spec.md) | Shared-key behavior, diagnostics, result lifetime, paging, profile validation and cancellation semantics |
| [UI redesign](ui-redesign.md) | One active view, restrained copy, on-demand detail, keyboard controls and responsive layouts |
| [XLSX input spec](xlsx-spec.md) | Displayed-text semantics, formula-cache handling, worksheet selection and provisional input caps |
| [XLSX export spec](xlsx-export-spec.md) | Fresh text-only cells, original values, formula-free output and refusal rather than truncation |
| [Benchmarks](benchmarks.md) | Whole-file parsing and export memory costs; measured versus chosen limits |
| [Browser verification](browser-verification.md) | Evidence for the recorded comparison snapshot, not reconciliation |
| [Deployed XLSX report](xlsx-browser-test-2026-10-06.md) | Independently generated input checks and the missing-formula-cache failure |
| [Deployed Reconcile report](reconcile-deployed-test-2026-10-07.md) | Assistant-run browser check of the deployed site after PR #2; deployment commit not independently verified |

Keep dated reports as historical evidence. New verification must name its commit,
environment and tested behaviors. Use separate labels for proposed, implemented,
tested and not yet verified behavior.

## 3. Correctness invariants

1. A transaction can belong to at most one active confirmed match.
2. Matching never crosses the session account or currency.
3. Transactions must have compatible normalized cash direction. Absolute amounts
   alone must never pair an inflow with an outflow.
4. Invalid or ambiguous amounts and dates are Problems, not zeroes, empty values or
   text-equality matches.
5. Original source values and source locations remain available after normalization.
6. Input order must not determine a pairing. Ties and competing candidates remain
   reviewable.
7. Amount tolerance permits a candidate; it does not erase its monetary variance.
8. Every candidate and confirmed match records its rule evidence.
9. A manual decision cannot silently bypass account, currency, cash-direction,
   unique-consumption or input-validity constraints.
10. Changed inputs or rules must not silently reuse incompatible decisions.
11. Cancellation or worker failure cannot destroy durably saved decisions.
12. Search exhaustion is reported separately from a completed search with no match.
13. Exports contain the full requested report, independent of loaded UI pages and
    table filters. Oversized exports fail explicitly rather than truncate.
14. Carry-forward never silently duplicates an item or discards an unresolved one.

Repeated identical rows are not automatically errors in reconciliation: they may
represent legitimate repeated transactions. They receive distinct identities and
can create candidate ambiguity. Do not inherit duplicate-key exclusion wholesale.

## 4. Source mapping and normalization

### Mapping per side

Use Bank and Books labels for the bank-reconciliation workflow rather than Old
and New. Each side has an independent mapping and parsing configuration.

| Field | Required behavior |
| --- | --- |
| Header row | Explicit header row number (default 1) and a count of trailing rows to skip, per side |
| Date | Select a column and one explicit format from the supported list; reject impossible dates and ambiguous interpretation |
| Amount | Select one signed column, or separate money-in/money-out columns |
| Direction | Explicitly map signed amounts or columns to cash inflow/outflow, labeled "money in" and "money out" |
| Reference | Optional column, retained as text with leading zeros |
| Description | Optional column, used for review context rather than automatic fuzzy matching |
| Worksheet | Select per source; preserve the selection across rereads |
| Account/currency | Explicit session context, with source metadata checks where supplied |

A selected account/currency is a user assertion when the files provide no metadata.
Show that distinction; do not claim the input has independently validated it.

Debit/credit labels are a trap: a bank statement labels from the bank's side, so its
"Credit" column is usually money in, while a books cash-account credit is money out.
The mapping UI names columns by cash flow, never by debit/credit, and the
normalization preview shows the resulting direction for both sides together.

For separate money-in/money-out columns, define the empty-value convention
explicitly in the profile. A blank unused side is not a generic numeric-to-zero
fallback. Rows with conflicting nonzero values in both columns are Problems, and so
is a negative value in either column (a reversal): it is never silently flipped to
the other direction. Zero-value transactions are shown separately and excluded from
automatic matching initially.

Dates normalize to calendar dates using a strict parser and calendar-day
arithmetic. Do not use implicit JavaScript date parsing or timezone-sensitive
timestamp differences. The profile declares whether its date is posting, value or
transaction date. Supported formats, chosen per side:

| Format | Accepted separators / notes |
| --- | --- |
| `YYYY-MM-DD` | ISO; also what SheetJS emits for ISO-formatted cells |
| `DD/MM/YYYY` | `/`, `-` or `.` as declared by the format, not guessed |
| `MM/DD/YYYY` | `/` or `-`; SheetJS renders Excel's default date format as `m/d/yy` |
| `DD-Mon-YYYY` | English month abbreviations (`05-Jan-2026`), case-insensitive |

Day and month may omit leading zeros. Two-digit years are rejected as Problems
unless the profile declares an explicit century pivot; there is no default pivot.
A value that fits the format but is impossible (`31/02/2026`) is a Problem. An
`.xlsx` date whose displayed text does not fit the declared format is a Problem, not
reinterpreted from the stored serial number.

Amounts use scaled `BigInt` decimals throughout parsing, sums, differences,
candidate checks and reports. Never use floating-point arithmetic for money. An
amount with more decimal places than the session currency's minor unit (two by
default; declared for currencies such as JPY or KWD) is a Problem, not rounded.
Reference normalization defaults to trimming only. Case folding is opt-in;
punctuation stripping and removal of leading zeros are not defaults.

### Source layout and encoding

Bank statements often put account details, the statement period and an opening
balance above the header, and totals or a closing balance below the data. The
current CSV reader treats the first non-blank line as the header and rejects any
record with the wrong field count, so such files are rejected today.

Reconcile adds, per side, two layout settings, both counted in **logical records**,
never physical lines:

- **Header record:** the header is the Nth non-blank record as the CSV parser reads
  it (worksheet rows for `.xlsx`, blank rows skipped as today). It therefore always
  starts at a record boundary, including when an earlier record holds a quoted
  multi-line field.
- **Trailing records to skip:** that many final non-blank records are excluded.

Preamble and skipped trailing records are excluded before transaction field-count
validation: they may have any number of fields. They are kept as raw text and shown
in the preview as skipped, not silently dropped. Their values (for example a printed
closing balance) are never read as balances automatically.

Source locations keep the record number counted from the first record after the
header, as Compare does, plus the physical line span (first and last line) of each
CSV record, so a reviewer can find a multi-line record in the original file.

Preamble prose is still read with CSV quoting rules. Free text without quotes
parses as a single-field record and is harmless. Prose with an unbalanced quote can
swallow the following lines; the parser then reports a structural problem and the
file is rejected rather than guessed at. The header setting makes the common
"details above the table" layout readable; it does not promise to read arbitrary
statement layouts such as several tables in one file, page headers repeated within
the data, or per-page subtotals. Those remain rejected by field-count validation.
Compare keeps its existing header rule.

Input stays strict UTF-8. Windows-1252 and other encodings remain rejected with the
current re-export message; an explicit encoding option is deferred.

### Format policy

Reuse the current plain-decimal, grouping and trailing-minus parser where
applicable. Further syntax needs an explicit, tested format policy; do not strip
arbitrary characters until a string happens to parse.

**Bracketed negatives** are an explicit per-side option: `(1,234.50)` reads as
−1234.50. The brackets must enclose the whole value; a sign inside them
(`(-100)`), a trailing minus with them (`(100)-`) or an unbalanced bracket is a
Problem. In money-in/money-out columns a bracketed value is negative and is
therefore reported as a reversal, like any negative there. Compare's numeric
rules are unchanged. Currency symbols and decimal commas remain undecided.

### Processor payouts and fees

A payment processor deposits the net amount: a 100.00 sale with a 3.00 fee arrives
as 97.00. Fees are never absorbed through amount tolerance: they vary per payment,
and a tolerance wide enough to hide them would also pair unrelated transactions.

- When a source carries the net amount (processor payout and balance reports
  usually do), map that column.
- When it carries gross and fee columns instead, the amount mapping may be
  **gross minus fee**. Initially this covers receipts only, with an explicit sign
  convention: the gross column holds a nonnegative magnitude, the fee column holds
  a nonnegative magnitude, and the mapping declares the direction of the result
  (money in for processor receipts). The net magnitude is `gross − fee`, computed
  exactly, and then takes the declared direction. A negative gross or fee, a blank
  or invalid fee, and a fee greater than the gross are Problems; a fee equal to
  the gross gives a zero-value row, kept out of matching. The fee stays available
  as a mapped field and is shown with the transaction. Refunds, chargebacks and
  payout reversals (where gross or fee change sign) are deferred until their
  convention is specified and tested.
- When the books record the gross receipt and the fee as two separate entries in
  opposite directions, pairing them with one bank deposit is cross-direction
  netting, which stays deferred. Until then those entries remain unmatched and
  visible rather than forced into a pair.

Fee mapping is a separately gated addition (section 12), not part of the durable
review milestone.

An invalid number in Compare may fall back to text equality with a warning.
Reconcile must instead exclude that transaction from matching and report why.

### XLSX precision and formula results

The initial mode inherits the XLSX reader's **displayed-text** semantics. Display
rounding may hide stored precision; make this limitation visible in mapping help
and exported provenance. Do not silently use raw workbook numbers for matching
while showing formatted text to the reviewer.

Raw-value matching is deferred until an explicit policy, preview and independent
CSV/XLSX tests establish its behavior. Dates rendered according to SheetJS's
formatting rules still need an explicit mapping format.

Missing formula caches must block affected inputs. Valid saved zero, FALSE and
empty-string results must remain distinguishable from absent results. Untyped
empty caches retain the current diagnostic note; financial fields that normalize
to invalid/empty values remain Problems.

### Preview and validation

Show original and normalized date, direction, amount and reference for a small
sample. Show total valid/invalid counts before matching and allow paging all
normalization problems. Missing profile columns or worksheets block that mapping;
never silently substitute a column or the first sheet.

## 5. Domain model and identity

Use separate reconciliation models, not additions to the shared-key
`CompareProfile` that alter its meaning.

| Model | Required contents |
| --- | --- |
| Reconciliation profile | Format/version, per-side parsing and mappings, normalization policies, matching rules, worksheet preferences |
| Source descriptor | Content fingerprint, filename, worksheet, parser semantics/version, original record locations |
| Transaction | Stable source-row ID, account/currency, original values, normalized date/amount/direction/reference |
| Candidate | Participating IDs, rule tier, exact amount variance, date evidence, reference evidence |
| Match | Participating IDs, accepted evidence, automatic/manual origin, decision metadata |
| Session | Format/version, account/currency/period, source descriptors, profile snapshot, revision, decision events, and normalized snapshots of transactions referenced by matches or outstanding items |
| Decision event | Sequence, confirm/reject/unmatch action, affected IDs, reason and session revision |
| Outstanding item | Stable lineage ID, origin session/source, original date, remaining signed amount, currency, status |

Source fingerprint plus original record identity distinguishes occurrences inside
an unchanged file. It does not establish economic identity across overlapping or
reordered exports. Repeated identical records must remain individually represented.
Carry-forward overlap detection therefore uses provenance and reviewable evidence,
not an assertion that equal content always means the same transaction.

JSON serializes exact decimals as validated strings or explicit units/scale text;
never JSON numbers. Import validates identity references, active match conflicts,
amounts, versions and decision consistency before changing active state.

## 6. Candidate matching and conflict resolution

### Candidate generation

Partition transactions by account, currency and direction. Index signed amount
and date so generation does not compare every row against every other row.

At zero tolerance, exact amount buckets are sufficient. At nonzero tolerance,
use ordered range lookup or neighboring buckets with exact final validation.
Candidates on bucket or date-window boundaries must not be missed.

The configured date window is inclusive and has separate bounds for how many days
the bank date may precede and follow the books date (default 3 and 3). Separate
bounds allow, for example, late-clearing cheques without widening the window in
both directions. Every candidate must satisfy its rule's amount/date constraints. Track candidate and conflict-group counts; repeated
amounts can still produce dense graphs and need explicit resource limits.

### Evidence tiers

Initial proposed precedence:

1. Exact normalized reference, exact amount, allowed date gap.
2. Exact normalized reference, amount within tolerance, allowed date gap.
3. Exact amount, allowed date gap, without a conflicting populated reference.
4. Amount within tolerance and allowed date gap, without a conflicting populated
   reference.

Missing references are neutral, not equal identifiers. Conflicting populated
references are excluded from automatic confirmation; permitting them as suggestions
requires an explicit policy. Description similarity is not used initially.

Reference rules only make sense when both mapped columns hold the same identifier
(for example a cheque number on both sides). A bank cheque number and a books
document number never match, so mapping both would mark every pair as conflicting
and suppress tiers 3 and 4. The mapping step therefore asks whether the two
reference columns share an identifier; if not, references are kept for review
context only and take no part in tiers or conflicts.

Within a tier, smaller amount variance then closer dates may order suggestions.
Ordering suggestions is not permission to confirm them. UI must explain the
precedence rather than imply statistically calibrated probabilities.

**No percentage confidence scores.** A figure such as "95% match" claims a
measured probability that a suggestion is right; nothing measures that. Evidence
is shown as the rules a pair met ("same reference, exact amount, 2 days apart").
A percentage may be considered only after it is calibrated against labeled
reconciliations, with the calibration data and method documented.

### Description similarity (subsequent release)

Descriptions rarely match exactly across sources ("STRIPE PAYMENTS INC" against
"Stripe Payout Oct 5"). Similarity may later order suggestions **within a tier**,
after amount and date ordering, and appear as evidence ("descriptions share
'stripe'"). It is never sufficient on its own to make a pair eligible, never moves
a pair between tiers and never contributes to confirmation. It is computed only for
candidates that already passed the amount and date rules, so it adds no
all-pairs work. The method (for example case-folded word tokens with common
words removed) must be deterministic, documented and tested.

### Ambiguity and automatic confirmation

Build conflict groups across both sides. Detect competition for the same
transaction, not just equal scores within one row. A greedy row-order pass is
not acceptable.

The first matching milestone produces suggestions only. The initial usable release
has **no automatic confirmation**: every match is confirmed by the reviewer. A
"unique" label (both transactions have exactly one eligible candidate) is review
context, not a decision.

Automatic confirmation may be added later as an explicit opt-in. Before it is,
specify and test the global assignment and uniqueness criterion, including how
rejected pairings count (see Reject in section 7): uniqueness must be computed
over the candidates that existed before any rejection, so that rejecting one
alternative can never make the remaining one auto-confirm. Never resolve tied
assignments using source order. Suggested candidates do not reserve transactions;
confirmed matches do.

### Interchangeable sets

Repeated identical transactions (for example twenty 9.99 subscription charges on
each side) form a dense conflict group where no pair is unique, so pairwise review
is impractical. Identical normalized fields do not prove economic interchangeability,
though: two payments can share date, amount and a blank reference while their
descriptions name different recipients.

A conflict group is an **interchangeable set** only when, on each side, every member
has the same normalized date, amount, direction and reference **and** the same
review-context text (the mapped description, compared exactly after trimming).
Groups that match on normalized fields but differ in description are shown as
"identical amounts and dates, different descriptions" and are reviewed pair by pair.
The first release has no acknowledgement path that turns them into a set; a
separately authorized bulk action for them would need its own specification.

The reviewer confirms a set in one action. The pairs use a deterministic assignment
that is recorded and shown as arbitrary within the set; it is not presented as
evidence that a specific row pairs with another.

With unequal side counts, the choice of which rows stay unmatched decides which
row becomes outstanding and carries its provenance forward. Before confirmation,
show which rows will remain unmatched (by default the latest by source location)
and let the reviewer change that choice. The rows left over are labeled as part of
the set. Groups that are not interchangeable get no bulk confirm.

Evidence examples:

- "Amount exact; bank date 2 days after books; reference matched."
- "Amount differs by 0.01; date exact; reference absent; confirmation required."
- "Three eligible counterparts; no unique pairing."

## 7. Human review and state lifetime

UI progression: **Files -> Map -> Review**, with one active view. Preserve source
and mapping state when navigating back.

Review tabs:

- **Suggested:** proposed pairings and competing alternatives.
- **Confirmed:** active accepted matches and their evidence.
- **Unmatched:** valid transactions not consumed by a confirmed match.
- **Problems:** invalid normalization, overlap conflicts and incomplete searches.

Ambiguous suggestions remain identifiable inside Suggested. Counts must state
their units: transactions, candidate pairings or confirmed groups. A transaction
may appear in several candidate suggestions, but only one confirmed group.

Use a row inspector for original rows, normalized fields, alternatives, variance
and copy actions. Provide key/reference search and date/direction filters through
worker-side queries before paging; never search only loaded rows.

Every review action is a visible button and also has a keyboard shortcut,
listed in the help and in each button's accessible description. Proposed:
↓/↑ or J/K move between rows, Enter opens the inspector, C confirms, X rejects,
O classifies as outstanding. Shortcuts are ignored while focus is in a text
field, go through exactly the same validation as the buttons, and never act on
a row the reviewer has not focused.

Support confirm, reject, manual 1:1 pair and unmatch. Manual exceptions to soft
amount/date/reference constraints require a reason and remain visibly labeled.
Do not edit source records or create write-off journal entries.

**Reject** applies to one pairing (an edge), not to its transactions. Rejecting
Bank A ↔ Books B removes that suggestion; A and B stay available for every other
pairing. A rejection is a decision event keyed by both transactions' source
identities, so it survives reruns. It stays in force while both transactions keep
their identity (same source fingerprints and locations) and lapses, becoming
historical, when either source is replaced. Mapping or rule changes do not lapse it:
a rejected pair that a new rule would suggest again stays hidden, counted under
"rejected suggestions" so it is never silently lost. The reviewer can list rejected
pairings and restore one, which is itself a decision event. Rejected edges never
make another candidate unique (section 6).

Keep an ordered decision history and implement explicit unmatch/reconfirm actions.

**Confirm** is atomic: validate the session revision and that both transactions are
valid and not consumed by an active confirmed match, record the decision event,
then update the displayed state. A failed validation changes nothing and says why.
Recording a decision is distinct from saving it; the save states are defined in
section 8, and a decision is never reported as saved before its write succeeds.

Source replacement, worksheet changes, mapping edits and matching-rule changes
create a new revision. Recompute suggestions. Decisions from incompatible
revisions remain historical or require explicit revalidation; they must not
silently become current.

## 8. Persistence, privacy and recovery

Profiles continue to contain rules only. Reconciliation sessions contain financial
records and decisions, which is a new privacy/storage contract.

Implement versioned JSON session export/import first. Then add opt-in IndexedDB
autosave with a clear explanation that data is stored in this browser, explicit
delete, backup export, and visible storage failures. Browser storage is not a
guaranteed backup or an encrypted vault.

Two independent indicators are always visible beside the session, because a
revision can be both saved in this browser and included in a backup:

| Indicator | States |
| --- | --- |
| Browser storage | Off (autosave not enabled) · Saving · Saved in this browser at revision N · Not saved: the error, with the last revision that was saved |
| Backup | No backup · Backup at revision N, current · Backup at revision N, outdated (later decisions are not in it) |

For example: "Saved in this browser · Backup at revision 12". A later decision
advances the revision: the browser indicator moves through Saving to the new
revision, and the backup becomes outdated without affecting the browser state.
Every decision is applied to the session first; until the browser indicator shows
its revision (or a backup includes it), a reload loses it. A storage failure shows
the error and keeps the last revision actually saved; there is no fallback that
reports success.

The UI owns durable session state outside the computation worker. Full records
must not be copied into React state; use a session repository and paged access.
The worker owns normalization/candidate indexes and disposable computation state.

Sessions do not store whole source files or every transaction: that would hold the
data twice in memory and could put hundreds of MiB into IndexedDB. A session stores
source fingerprints, the profile, decision events and normalized snapshots (original
values, location, date, amount, direction, reference) of transactions that matches
or outstanding items refer to. Restoring requires the source files again; their
fingerprints must match before decisions apply, and a mismatch leaves decisions
historical until revalidated. Fingerprints are SHA-256 of the file bytes, computed
in the worker.

This keeps a session small only when few transactions are matched or outstanding.
In a typical month nearly every transaction is one or the other, so the snapshots
approach the size of the whole normalized dataset, plus the decision history. Before
milestone 3 ships, measure that worst case (every row matched or outstanding, with a
long decision history) for session size, IndexedDB write time and JSON export
memory, and set the session limits from those measurements.

Retain hard worker termination for reliable cancellation initially. A cancelled
run is incomplete and cannot be reported as a complete no-match result. Restore
from a saved session or explicitly reread sources before resuming computation.
Saved decisions remain accessible and are validated against the restored revision.

Handle missing storage, quota exhaustion, corrupted import, unsupported versions,
worker crashes and reloads explicitly. No success-shaped memory fallback that
claims data is saved. Multiple tabs must detect conflicting session revisions
before overwriting decisions.

## 9. Balances and carry-forward

### Accounting checks

Separate three claims:

1. **Source validation:** opening balance plus normalized movement equals closing
   balance, under the declared sign and balance basis.
2. **Transaction matching:** confirmed groups account for paired movements, with
   any variance recorded.
3. **Reconciliation:** an explicit bridge explains the closing balance difference
   using outstanding items and confirmed variances.

Balance fields are optional for transaction matching but required before claiming
an account is reconciled. Opening and closing balances are entered per side as
exact decimal text, with the source of each recorded (typed by the user, or read
from a declared running-balance column). An optional running-balance column is
validated row by row and reports the first break, which also exposes missing or
reordered rows. Balances printed in skipped header/footer rows are not read
automatically. If books use liability-style balances, normalize the
balance basis explicitly rather than assuming the cash-sign convention applies.

For a session without carry-forward, let `B` be bank and `L` be books, with all
movements expressed as signed cash flows. The bridge is:

```text
B_close - L_close
  = (B_open - L_open)
  + sum(unmatched bank movements)
  - sum(unmatched book movements)
  + sum(confirmed bank totals - confirmed book totals)
```

With carry-forward, prior outstanding items explain the opening difference and
retain their original posting period. They are never added again to
current-period source movement; they form a separate pool of **opening items** on
their original side, available for matching against the other side's current
movements. Let `O_B` and `O_L` be the remaining (unconsumed) opening items:

```text
Opening check:  B_open - L_open = sum(all O_B) - sum(all O_L)

B_close - L_close
  = sum(remaining O_B) - sum(remaining O_L)
  + sum(unmatched bank movements)
  - sum(unmatched book movements)
  + sum(confirmed bank totals - confirmed book totals)
```

A confirmed group may contain an opening item; it counts in that group's side total
at its carried amount. An opening item matches only a current movement on the other
side. A same-side offset (books reversing its own cheque) is cross-direction netting
and stays deferred.

#### Worked two-month example (design gate for milestone 4)

One account, INR, signed cash flows, bank date window 3 days either side.

**September.** Both sources open at 1,000.00.

| Side | Date | Item | Amount |
| --- | --- | --- | ---: |
| Books | 10-Sep | Receipt | +300.00 |
| Bank | 11-Sep | Receipt | +300.00 |
| Books | 29-Sep | Cheque 101 issued | −200.00 |

Closing: books 1,100.00; bank 1,300.00; difference `B − L` = 200.00.
The receipts are confirmed (0.00 variance). Bridge: `0 + 0 − (−200.00) + 0 = 200.00`.
Outstanding at month-end: cheque 101, books side, −200.00, lineage `L1`, original
date 29-Sep, origin September session.

**October.** Opening: books 1,100.00; bank 1,300.00; difference 200.00. Imported
opening item: `L1` (books, −200.00). Opening check: `0 − (−200.00) = 200.00`. ✓

| Side | Date | Item | Amount |
| --- | --- | --- | ---: |
| Bank | 02-Oct | Cheque 101 cleared | −200.00 |
| Books | 30-Oct | Receipt | +500.00 |
| Bank | 31-Oct | Bank charge | −10.00 |

Current-period movement sums: bank −210.00; books +500.00. `L1` is **not** included:
it belongs to September's books movement. Closing: bank 1,090.00; books 1,600.00;
difference −510.00. Source check per side: `1,300.00 − 210.00 = 1,090.00` and
`1,100.00 + 500.00 = 1,600.00`.

The bank's 02-Oct −200.00 is confirmed against opening item `L1` (3 days, exact).
`L1` is consumed; its lineage records that it cleared in the October session.
Bridge: `0 − 0 + (−10.00) − (+500.00) + ((−200.00) − (−200.00)) = −510.00`. ✓

Outstanding at October month-end: the bank charge (bank side, −10.00, new lineage
`L2`, awaiting a books entry) and the receipt (books side, +500.00, new lineage `L3`,
deposit in transit). `L1` is not carried again.

This example fixes the model: opening items are a separate pool, excluded from
movement sums, consumed in full by a confirmed group and carried with their original
lineage and date while unconsumed. It becomes the first milestone-4 fixture, with
the overlapping-export and repeated-transaction cases in the monthly workflow
below added to it. A cheque that clears later than the window allows (common)
needs a wider bank-after bound; the fixture should include one such case.

Invalid rows have no trustworthy amount, so they belong to neither the matched nor
the unmatched sums. While any row in the period is invalid, the bridge is
incomplete by definition: show the computed difference, the number of invalid rows
per side and their original text, never a reconciled status.

Display invalid/unprocessed totals and incomplete search status separately.
Never describe an incomplete balance bridge as reconciled. Tolerance residuals
remain explicit; fees and write-offs need a future adjustment workflow.

### What earns "reconciled"

Once every valid transaction is classified as matched or unmatched, the bridge is
an accounting identity: it balances whether or not anyone reviewed anything. If
both sources open at zero and each holds the same ₹100 receipt, leaving both
unmatched gives `100 − 100 = 0`. A balanced bridge is therefore never sufficient on
its own. Four separate statuses are shown, each with its own evidence:

| Status | Earned when |
| --- | --- |
| Source balances validated | Per side: opening balance plus current-period movement equals closing balance, with no invalid rows on that side |
| Balance bridge complete | Both sides validated; opening items pass the opening check; no incomplete searches; the bridge is computed |
| Outstanding items reviewed | Every remaining unmatched movement and opening item is acknowledged and classified by the reviewer (for example outstanding cheque, deposit in transit, bank entry to record in books, error to investigate) |
| Reconciliation completed | All three above, no unresolved Problems, an accepted explanation for every confirmed variance, and an explicit "mark complete" decision by the reviewer |

The opening check must hold exactly: the opening difference is fully covered by
imported opening items. An explanation cannot stand in for a missing term in the
bridge, so an uncovered opening difference leaves the bridge incomplete. Supporting
it later needs an explicit **opening-difference item** (amount, side, explanation,
who accepted it, and its lifecycle across periods), specified and tested before use.

Valid outstanding items, such as an uncleared cheque, may remain when reconciliation
is completed; they carry forward. Completion is withdrawn, until marked again, by
any later review decision and by any configuration change: source replacement or
worksheet change, mapping edits, matching-rule changes, balance edits and
opening-item imports. During the experimental milestones 1-3,
none of these statuses is shown and the UI never uses the word "reconciled".

### Monthly workflow

Export outstanding items with original date, side/direction, exact remaining
amount, account/currency, source provenance and lineage. Import into the next
session as opening items, not newly posted transactions.

Validate account, currency, periods, duplicate lineage and overlapping source
imports. Potential overlaps require review. Already cleared items cannot be
carried forward as outstanding without an explicit reversal decision.

The release fixture must cover two consecutive months, clearing an outstanding
cheque, an overlapping export, repeated identical transactions, and one item that
remains outstanding.

Partial settlements are deferred: initial carried items are consumed in full or
remain outstanding.

## 10. Bounded grouped matching

Add grouped suggestions after the monthly 1:1 workflow is reliable, in this order.

### Grouping by a payout or batch ID first

A processor payout often settles dozens of charges, far beyond any feasible subset
search. Processor reports carry the payout (or batch, settlement) ID on each
member row. When a side maps such a column, its rows are grouped by that ID. Each
group's exact signed sum, at the latest member date, becomes one aggregate
transaction matched 1:1 against the other side under the normal rules. This is
exact and linear in the number of rows. The review shows every member; members
with invalid amounts make the whole group a Problem rather than a smaller sum. A
group whose members differ in direction is blocked from matching: matching its net
sum would be cross-direction netting, which is deferred. Its members are shown for
diagnosis, and no review action can override the block.

Batch grouping is a separately gated addition (section 12), not part of the
durable review milestone.

### Bounded subset search as the fallback

For rows without a group ID, add opt-in 1:N and N:1 subset search. Start with a
maximum group size of four; increasing it requires new measurements. Large
settlements are expected to use ID grouping, not this search.

Search only residual transactions, within the same account/currency/direction and
configured date window. Confirmed 1:1 matches are excluded. Tentative suggestions
remain reconsiderable.

Use exact subset sums and tolerance checks. Every proposed group explains each
member's date/reference evidence and the aggregate variance. Multiple groups or
overlapping alternatives remain reviewable; never auto-confirm them initially.

Group size alone does not bound the work. Define measured limits for candidate
pool size, generated candidates, combinations examined and elapsed execution.
Use deterministic ordering and a fixed work budget for repeatable completeness
claims; an elapsed-time abort is an additional safety stop and may vary by device.
Any early stop marks that search as incomplete.

Pruning must be mathematically valid under the direction/sign constraints.
Cross-direction netting and partial allocations are out of scope.

## 11. Architecture and exports

Proposed boundaries:

| Area | Responsibility |
| --- | --- |
| Existing engine/parsers | Retain comparison semantics; reuse CSV/XLSX reading and exact decimal primitives |
| `src/reconciliation/` | Pure normalization, candidate generation, conflict detection, accounting checks and grouped search |
| Reconciliation profile module | Independent versioned validation and comparison of mapping/matching policies |
| Session repository | Validated session JSON, IndexedDB persistence, revisions and decision events |
| Worker protocol/handler | Reconciliation commands, progress, revision-safe paging and report creation |
| Reconciliation UI | Files, Map, Review, inspector and monthly continuation |

Worker requests and results must carry session/revision identity. Reject stale
pages and decision commands rather than serving a newer run. Preserve current
Compare commands and profile/report formats.

Expose progress phases for normalization, candidate generation, conflict analysis,
grouped search and export. Account for synchronous XLSX reading phases that do not
provide granular progress.

Reconciliation Excel/JSON reports contain source/worksheet provenance, mappings,
rules, valid/invalid counts, matches and evidence, decisions, variances, balance
checks, outstanding items and incomplete-search diagnostics.

Preserve text-only, formula-free XLSX cells and current workbook limits. Check
expanded report size before construction. CSV reports retain formula protection;
session backup and carry-forward JSON are distinct, versioned formats.

Do not silently alter `csv-diff-report` or `csv-diff-profile` for new domains.

## 12. Milestones and acceptance gates

| Milestone | Deliverable | Exit condition |
| --- | --- | --- |
| 0. Baseline and contracts | Committed Playwright check of missing formula caches using `fixtures/xlsxwriter`; file reading extracted from the Compare handler for reuse; exact-decimal add/subtract/compare/format; header-row and trailing-row reading; fixtures, schemas and policies | Formula-cache browser check passes in the committed suite; Compare tests unchanged; inherited limitations recorded |
| 1. Mode and mapping | Files/Map UI, independent mappings, normalization/problems | Equivalent supported CSV/XLSX values normalize identically; invalid fields cannot match |
| 2. Candidate engine | Indexed 1:1 suggestions and conflicts | Input-order independence, boundary correctness and no hidden ambiguity |
| 3. Durable review | Decisions with buttons and keyboard shortcuts, manual pairing, save/load and opt-in autosave | Entry: a browser measurement of a dense repeated-amount case through candidate search and conflict analysis, with peak memory, and the candidate budget set from it. Exit: reload/cancel/rerun/import preserve valid decisions; incompatible revisions blocked; save and backup indicators tested |
| 4. Monthly reconciliation | Balance bridge, completion statuses, outstanding-item continuation and reports | The section 9 worked example passes as a fixture before the continuation UI is built; two-month fixtures conserve money and prevent duplicate carry-forward; a balanced bridge alone never yields "completed" |
| 5. Grouped suggestions | Bounded 1:N/N:1 residual search | Conflict and budget exhaustion tests pass; cancellation remains usable |
| Gated: fee mapping | Gross-minus-fee receipts with the section 4 sign convention | Can ship after milestone 2; does not enlarge milestone 3; exactness, fee-above-gross and refund exclusion tests |
| Gated: batch grouping | Payout/batch-ID aggregates matched 1:1 | Can ship after milestone 3; mixed-direction groups blocked; large-group and invalid-member tests |
| 6. Release and naming | Documentation, browser/spreadsheet verification, optional rename | Compare regressions pass; release claims match evidence |

Do not enable grouped matching before milestone 4. The mode may be labeled
experimental during milestones 1-3, without claiming complete account reconciliation.

## 13. Validation strategy

### Engine fixtures and invariants

- Separate debit/credit versus signed amounts; reversed bank/book conventions;
  negative values in money-in/money-out columns.
- Bank CSV/`.xlsx` with preamble and footer rows; header-row record locations.
- Reference columns declared as shared identifiers versus context only.
- Interchangeable sets with equal and unequal side counts; near-identical groups
  that must not qualify.
- Amounts exceeding the currency's minor unit; two-digit years without a pivot.
- Western/Indian grouping, trailing minus, invalid values and explicit format rules.
- Date-window boundaries, leap days, impossible dates and ambiguous date strings.
- Missing, exact, conflicting and leading-zero references.
- Repeated amounts, repeated identical rows, competing counterparts and ties.
- Exact/tolerance boundaries, equivalent decimal scales and retained variance.
- Zero-value transactions and invalid records excluded from automatic matching.
- Permuted inputs produce equivalent economic suggestions and confirmations.
- No transaction consumed twice; counts and monetary totals conserve each source.
- Grouped alternatives, overlapping groups and deterministic work-limit exhaustion.

### Sessions and accounting

- Version validation/migrations, exact-decimal serialization and invalid imports.
- Decision replay, confirm/unmatch/reconfirm, stale revisions and multiple tabs.
- Reject survives reruns and rule changes, lapses on source replacement, can be
  restored, and never makes another candidate unique.
- Save indicators: browser storage and backup tracked independently; a later
  decision makes the backup outdated without changing the browser state; a storage
  failure keeps the last revision saved; confirm atomicity under a stale revision.
- Completion statuses: a fully unmatched but balancing bridge is not "completed";
  Problems and unreviewed outstanding items block completion.
- Completion is withdrawn by later decisions and by source, worksheet, mapping,
  rule, balance and opening-item changes; an uncovered opening difference blocks it.
- Quota/storage failure, cancellation, worker failure and restore from backup.
- Balance validation and unexplained difference; incomplete data never yields success.
- Carry-forward lineage, overlapping imports, cleared items and two-month totals.

### UI and reports

- Independent mapping/worksheet selection, normalization preview and all-problem paging.
- Keyboard/touch navigation, focus transitions, long values and mobile inspector.
- Review decisions and filters over full worker results, not UI page caches.
- XLSX formula-cache regression using independently generated workbooks.
- Excel-generated workbook/CSV pairs for supported formatting.
- Actual exported workbooks opened in Excel and other stated supported spreadsheets.
- Exact original strings, formula-free cells, leading zeros and limit refusals.

### Performance

Benchmark normalization, candidate generation, conflict groups, paging, decisions,
session save/load, grouped search and exports. Use realistic and adversarial cases:
many equal amounts, wide date windows, dense references and multi-sheet workbooks.
Measure the full browser pipeline and peak memory, not only Node engine timings.

Existing limits remain provisional. Reconciliation limits require new evidence;
do not assume that fitting under parser caps means a candidate graph will fit.
Preserve the project's existing test/build/lint checks throughout development.

## 14. Decisions

### Accepted (2026-10-07)

| Decision | Choice | Tests required |
| --- | --- | --- |
| Date formats | `YYYY-MM-DD`, `DD/MM/YYYY`, `MM/DD/YYYY`, `DD-Mon-YYYY`, chosen explicitly per side; no two-digit years without a declared pivot | Each format, leap days, impossible dates, wrong-format values, `.xlsx` displayed dates |
| Default matching rules | Amount tolerance 0; date window 3 days before and 3 after, inclusive, adjustable per bound. Tolerance is fixed at 0 during milestones 1-3; tiers 2 and 4 are not implemented until a nonzero tolerance is offered | Window boundaries on both sides, exact amounts at differing scales |
| Automatic confirmation | None in the initial usable release; every match is confirmed manually. The mode is labeled experimental and suggestion-only through milestone 2 | No code path creates a confirmed match without a reviewer action |
| Conflicting references | Pairs whose shared-identifier references conflict are not suggested | Conflict excluded at every tier; context-only references ignored |
| Bracketed negatives | Explicit per-side option in Reconcile; Compare unchanged | Grouped and plain values, misplaced signs, unbalanced brackets, reversal in split columns |
| Fees | Map net, or gross minus fee for nonnegative receipts with a declared direction; never tolerance. Refunds and cross-direction netting deferred. Separately gated | Exactness, fee above gross, negative or blank fee as Problems (with the fee mapping) |
| Confidence | Rule-based evidence; no percentage scores without documented calibration | No percentage appears in suggestions or reports |
| Grouped matching order | Payout/batch-ID grouping before subset search; mixed-direction groups blocked. Separately gated | Large ID groups, mixed-direction block, invalid members |
| Interchangeable sets | Identical descriptions required in the first release; no acknowledgement path | Description difference prevents bulk confirm |
| Opening differences | Must be fully covered by opening items; an explicit opening-difference item is deferred | Uncovered opening difference leaves the bridge incomplete |
| Description similarity | Ranking within a tier only, never eligibility or confirmation | Same candidate set with and without similarity (with its release) |
| Source layout | Explicit header row and trailing rows to skip in Reconcile; strict UTF-8 retained | Preamble/footer CSV and `.xlsx`, original record locations, Compare unchanged |

### Still to settle before coding the relevant milestone

- Additional amount syntax (currency symbols, decimal comma).
- Whether a later opt-in automatic confirmation is offered, and its uniqueness rule.
- Session backup contents and autosave retention/deletion policy.
- Exact accounting treatment and UI for imported opening items.
- Measured candidate/grouped-search and session-size budgets.
- Final product name and URL migration.

These are implementation gates, not silent defaults. Record each accepted decision
and its tests in this spec as milestones begin.

## 15. Implementation status (milestones 0-2)

Labels as in the [V1 implementation spec](v1-implementation-spec.md):
implemented, tested, not yet verified, not implemented. Each snapshot lists its
own checks; results from one do not carry over to another.

### Baseline snapshot: `84aa1b5` on `main` (PR #2), 2026-10-07

| Area | Where | Tests |
| --- | --- | --- |
| Exact decimal add, subtract, compare, rescale, format | `src/engine/decimal.ts` | Unit tests |
| Header record and trailing-record skip, counted in logical records; CSV line spans and `.xlsx` row numbers; skipped records kept as raw text; Compare unchanged without a layout | `src/engine/parse.ts`, `src/engine/xlsx.ts` | Unit tests, including a quoted multi-line preamble, an unterminated quote, an unsaved formula in a skipped row |
| File reading shared by both workers | `src/worker/read-source.ts` | Existing Compare handler tests |
| Missing `.xlsx` formula results, in the browser | `e2e/xlsx-formula-cache.spec.ts` | Playwright, Chrome, with the XlsxWriter fixtures: missing result, formula-only row, header formula, saved zero/FALSE/empty string |
| Strict dates in the seven accepted formats, calendar-day numbers without `Date` | `src/reconciliation/dates.ts` | Unit tests: leap days, impossible dates, wrong format, two-digit years |
| Normalization: signed or money-in/money-out amounts, currency scale, negative/conflicting/blank split amounts as problems, zero-value rows kept apart, missing columns blocking | `src/reconciliation/normalize.ts` | Unit tests |
| 1:1 candidates: exact signed amount, inclusive asymmetric window, shared-reference tier 1, conflicting references excluded, conflict groups across both sides, candidate budget reported as incomplete | `src/reconciliation/match.ts` | Unit tests, including 20 shuffled input orders giving identical suggestions |
| Reconcile worker: per-side layouts, SHA-256 fingerprints, revisions, stale-request rejection, worker-side search, direction filter and paging | `src/worker/reconcile-handler.ts` | Unit tests |
| Files -> Map -> Review UI, experimental banner, mode switch keeping both modes' state | `src/ui/reconcile/`, `src/ui/Root.tsx` | Playwright: full flow, search, tabs, stale-setup gating, mode switching, no horizontal overflow at 390 and 768 px |

Checks run locally on this snapshot's branch head before merge: `npm test` 334 passed; `npm run lint` clean; `npm run build`
passed; `npm run test:ui` 19 passed. Two Compare checks in `e2e/workspace.spec.ts`
that already failed on `main` were fixed alongside: a stale "1 ambiguous keys"
assertion, and the 1440 px results page, which the rules summary had pushed to
981 px against the 900 px no-scroll check.

An assistant-run browser check of the deployed site after PR #2 merged passed for
the date window, competing pairs, exclusions, normalization problems, CSV/`.xlsx`
agreement, preamble line numbers, input blocking, exact values and a basic Compare
regression: see the [deployed Reconcile report](reconcile-deployed-test-2026-10-07.md)
(desktop Chrome in a remote cloud browser, 1363 × 936 viewport). The deployment
commit was not independently verified.

### Additions after `84aa1b5` (PR #3, not yet merged)

| Area | Commit | Where | Tests |
| --- | --- | --- | --- |
| Bracketed negatives as an explicit per-side mapping option | `5bde8fd` | `src/engine/decimal.ts`, `src/reconciliation/normalize.ts`, mapping form | Unit tests: grouped values, misplaced signs, unbalanced brackets, reversal in split columns |
| Cancel in Reconcile | `ae1bcc6` (test only) | `e2e/reconcile.spec.ts` | Playwright: cancel while reading a 600,000-row statement, then read again; cancel after suggestions exist drops them and asks for both files again |

Checks run locally at `ae1bcc6`: `npm test` 345 passed; `npm run lint` clean;
`npm run build` passed; `npm run test:ui` 21 passed in each of two repeated runs,
and the two cancel tests passed five repeats. The deployed site has not been
checked with these additions.



### Not implemented in this snapshot

- Any decision: confirm, reject, manual pair, unmatch, interchangeable-set bulk
  confirm (milestone 3). The UI has no confirm control.
- Amount tolerance (fixed at zero) and therefore tiers 2 and 4.
- Two-digit-year pivots: such dates are always problems.
- Saving reconciliation profiles or sessions; reloading clears the session.
- Exports, balances, completion statuses, carry-forward, grouped matching.
- Per-file worksheet preferences beyond the existing sheet picker.

### Not yet verified

- Real bank and accounting-system exports; Excel-generated workbooks.
- Cancel pressed while matching specifically. Matching is capped at the candidate
  budget and finished in under a second in Node measurements, so a browser test cannot
  land Cancel inside it reliably; the UI runs the same cancel path for every task.
- Candidate-budget exhaustion in a browser.
- Large inputs: no reconciliation benchmark has been run, and the 2,000,000
  candidate budget is chosen, not measured.
- Other browsers, screen readers and touch use of the new forms.
