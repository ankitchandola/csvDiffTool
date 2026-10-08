# Reconcile fixtures: Indian statements and ledgers

Written by `npx tsx scripts/fixtures/reconcile-india.ts`, which computes every balance and
running balance. Change the transactions there, not in the files. The layouts follow
common Indian bank and accounting exports. Names and numbers are made up.

Both scenarios cover September 2026 and are exercised by `e2e/reconcile-realistic.spec.ts`.

## A: ICICI-style statement vs Tally-style ledger

| File | Layout |
| --- | --- |
| `icici-statement-2026-09.csv` | 3 preamble records, header is record 4, 2 legend records at the end; `DD/MM/YYYY`; separate withdrawal and deposit columns; lakh grouping (`1,25,000.00`); cheque number and running balance columns |
| `tally-icici-ledger-2026-09.csv` | 5 preamble records, header is record 6; `1-Sep-2026` (`DD-Mon-YYYY`); Debit is money in, Credit is money out; an "Opening Balance" line right below the header; totals and "Closing Balance" lines at the end (skip 2) |

Balances: bank ₹2,50,000.00 → ₹28,855.30, books ₹2,50,000.00 → ₹45,628.00.

With the default ±3-day window there are 10 candidate pairs, all unique. Several cheques,
ACH debits and the BESCOM payment clear a day after the ledger entry. Two settlements of
₹18,450.00 fall 23 days apart, so they don't compete.

These stay unmatched:
- the bulk salary debit (₹1,80,000.00) against three salary entries;
- SMS charges (₹17.70) and interest (₹1,245.00) not yet in the books;
- a cheque issued but not presented (₹22,000.00) and a deposit in transit (₹40,000.00).

The bridge explains the ₹-16,772.70 closing difference.

## B: HDFC-style .xlsx statement vs Zoho-style books export

| File | Layout |
| --- | --- |
| `hdfc-statement-2026-09.xlsx` | 5 preamble rows and a blank row, header is record 6; real date cells shown as `dd/mm/yyyy`; numbers formatted `#,##0.00`; reference numbers with leading zeros; a statement summary at the end (skip 3) |
| `zoho-hdfc-transactions-2026-09.csv` | header only; `YYYY-MM-DD`; one signed amount column with lakh grouping |

Balances: bank ₹1,00,000.00 → ₹2,91,477.40, books ₹1,00,000.00 → ₹2,73,001.00.

There are 8 candidate pairs in 5 groups. Two ₹45,000.00 IMPS payments to the same payee on
the same day compete with two bills. The ATM fee (₹23.60) and an unpaid bill (₹18,500.00)
stay unmatched. This scenario reaches "Reconciliation completed".

## What these files showed

- **A Tally opening-balance line blocks completion.** The line sits directly below the
  header and has no date, so it is read as a record with a problem. Only records above
  the header or at the end can be skipped, so the books source never validates and the
  reconciliation can't be completed without editing the file.
- **Bulk payments need grouped matching** (milestone 5). A single salary or vendor batch
  debit against individual ledger entries stays unmatched on both sides.
- **Identical-set confirmation rarely applies to real statements.** A set needs equal
  references, and IMPS, UPI and NEFT rows carry unique reference numbers. Same-amount,
  same-day payments are reviewed pair by pair.

Formats deliberately left out of these files because Reconcile doesn't read them yet:

- **Two-digit years:** `01/09/26` in HDFC CSV downloads, and `1-Sep-26`, Tally's default.
  They are refused with "has a two-digit year".
- **Space-separated dates with a named month:** `1 Sep 2026`, used by SBI.
- **Balances with a Cr/Dr suffix:** `5,00,000.00 Cr`. A running-balance column written
  this way can't be checked.
