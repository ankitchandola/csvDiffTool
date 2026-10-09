# Reconcile fixtures: Indian statements and ledgers

Written by `npx tsx scripts/fixtures/reconcile-india.ts`, which computes every balance and
running balance. Change the transactions there, not in the files. The layouts follow
common Indian bank and accounting exports. Names and numbers are made up.

All three scenarios cover September 2026 and are exercised by `e2e/reconcile-realistic.spec.ts`.

## A: ICICI-style statement vs Tally-style ledger

| File | Layout |
| --- | --- |
| `icici-statement-2026-09.csv` | 3 preamble records, header is record 4, 2 legend records at the end; `DD/MM/YYYY`; separate withdrawal and deposit columns; lakh grouping (`1,25,000.00`); cheque number and running balance columns |
| `tally-icici-ledger-2026-09.csv` | 5 preamble records, header is record 6; `1-Sep-2026` (`DD-Mon-YYYY`); Debit is money in, Credit is money out; an "Opening Balance" line right below the header (skip 1 after the header); totals and "Closing Balance" lines at the end (skip 2) |

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

## C: SBI-style statement vs Tally-style ledger with two-digit years

The same account and transactions as A, so the same figures and outcome.

| File | Layout |
| --- | --- |
| `sbi-statement-2026-09.csv` | 8 preamble records and a blank line, header is record 9, 1 footer record; `1 Sep 2026` (`DD Mon YYYY`); unused amount cells hold a space; balances marked `Cr` |
| `tally-sbi-ledger-2026-09.csv` | Tally's default `1-Sep-26` (`DD-Mon-YY`); otherwise as A's ledger |

## What these files showed

- **A Tally opening-balance line sits right below the header.** It has no date, so it
  used to be read as a problem record that blocked completion. It is now skipped with
  "Skip records after the header".
- **Bulk payments need grouped matching.** A single salary or vendor batch debit against
  individual ledger entries has no shared ID, so the reviewer selects the debit and the
  three salary entries and confirms them as a group; scenarios A and C do this.
- **Identical-set confirmation rarely applies to real statements.** A set needs equal
  references, and IMPS, UPI and NEFT rows carry unique reference numbers. Same-amount,
  same-day payments are reviewed pair by pair.
- **Two-digit years, `1 Sep 2026` dates and Cr/Dr-marked balances weren't read.** HDFC
  CSV downloads use `01/09/26`, Tally defaults to `1-Sep-26`, SBI writes `1 Sep 2026`,
  and many statements mark balances `5,00,000.00 Cr`. The `DD/MM/YY`, `DD-Mon-YY` and
  `DD Mon YYYY` formats and the "Balances marked Cr or Dr" choice now cover them;
  scenario C exercises them.
