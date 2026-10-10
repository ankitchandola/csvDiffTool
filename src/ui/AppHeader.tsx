import { LockKeyhole } from 'lucide-react'
import { type Mode, WORKSPACE_IDS } from './mode'
import { MAX_FIELDS, MAX_FILE_BYTES, MAX_XLSX_BYTES, MAX_XLSX_FIELDS } from '../engine/limits'


function FormatsAndLimits() {
  return (
    <details>
      <summary>File formats and limits</summary>
      <p>Use a UTF-8 CSV (or TSV) or an .xlsx workbook; for a workbook, one sheet per file is compared, as Excel displays it. Headers are trimmed automatically. Leading zeros can be lost when a spreadsheet opens a CSV; the JSON report and the Excel workbook export keep the original text.</p>
      <p>
        Per-file limits: CSV {MAX_FILE_BYTES / 2 ** 20} MiB and {MAX_FIELDS.toLocaleString('en-US')} fields; .xlsx{' '}
        {MAX_XLSX_BYTES / 2 ** 20} MiB and {MAX_XLSX_FIELDS.toLocaleString('en-US')} fields. Capacity depends on your
        browser and device.
      </p>
    </details>
  )
}

export function AppHeader({ mode, onModeChange }: { mode: Mode; onModeChange: (mode: Mode) => void }) {
  return (
    <>
      <a className="skip-link" href={`#${WORKSPACE_IDS[mode]}`}>
        Skip to workspace
      </a>
      <header className="app-header">
        <a className="brand" href={`#${WORKSPACE_IDS[mode]}`} aria-label="Recon Desk workspace">
          <img
            className="brand-icon"
            src={`${import.meta.env.BASE_URL}favicon.svg?v=original-brand`}
            width="32"
            height="32"
            alt=""
          />
          <span>Recon Desk</span>
        </a>
        <div className="mode-switch" role="group" aria-label="Mode">
          <button type="button" aria-pressed={mode === 'compare'} onClick={() => onModeChange('compare')}>
            Compare
          </button>
          <button type="button" aria-pressed={mode === 'reconcile'} onClick={() => onModeChange('reconcile')}>
            Reconcile <span className="experimental-badge">Experimental</span>
          </button>
        </div>
        <div className="header-end">
          <span className="privacy-badge">
            <LockKeyhole size={14} aria-hidden="true" /> Files stay local
          </span>
          <details className="help-disclosure">
            <summary>Help</summary>
            {mode === 'compare' ? (
              <div className="help-content">
                <h2>Comparing CSV files</h2>
                <p>Load an old and a new export, then choose the columns that identify the same record in both files.</p>
                <p>A key can be one column, such as <code>invoice_id</code>, or a combination like <code>warehouse + sku</code>.</p>
                <details>
                  <summary>Excluded records and warnings</summary>
                  <p>Duplicate keys and records with an empty key component are excluded. Numeric warnings flag values that could not be read as numbers.</p>
                </details>
                <FormatsAndLimits />
                <p className="note">Files stay in this browser. Saved profiles contain rules, never file contents.</p>
              </div>
            ) : (
              <div className="help-content">
                <h2>Reconciling a bank statement</h2>
                <p>Load the bank statement and your books, map each file's date, amount and reference, then review suggested pairs.</p>
                <p>This mode is experimental. You confirm every match yourself; nothing is confirmed automatically.</p>
                <details>
                  <summary>Balances and completion</summary>
                  <p>Enter the period and each side's opening and closing balances on the Map step. Four statuses then show what is earned: source balances validated, balance bridge complete, outstanding items reviewed (every unmatched item classified; O applies the usual classification), and reconciliation completed, which also needs no problem rows and your explicit mark. A balancing bridge alone is not completion. Any later decision or change to files, mappings, rules or balances withdraws the mark.</p>
                  <p>At month-end, Export outstanding items saves what is still unmatched. In the next period, import that file on the Map step: its items keep their original dates, are matched against the new period's transactions, and are not counted in its movement. An optional running-balance column is checked row by row and reports the first break.</p>
                  <p>Report (JSON) and Report (Excel) record the files with their SHA-256 fingerprints, the mappings and rules, balances and statuses as they stand, every confirmed match with its evidence, outstanding items with their classification, problem rows and the full decision history. Excel cells are all text.</p>
                </details>
                <details>
                  <summary>Review decisions and keys</summary>
                  <p>Confirm or reject suggested pairs, unmatch a confirmed pair, restore a rejected one, or pair two unmatched transactions by hand; a hand-made pair that breaks the rules needs a reason. On a focused row, J/K or ↓/↑ move, C confirms, X rejects and Enter shows its details: the whole source row, any confirmed match and other open suggestions.</p>
                  <p>When repeated transactions are identical on each side, including their descriptions, Confirm set pairs them in one step; the pairing within the set is arbitrary, and you choose which extra rows stay unmatched.</p>
                </details>
                <details>
                  <summary>How pairs are suggested</summary>
                  <p>A pair needs the same amount and cash direction, with dates inside the window you set. When both reference columns hold the same identifier, matching references come first and differing ones are not suggested. When several pairs compete for a transaction, they are grouped so you can see the alternatives.</p>
                </details>
                <details>
                  <summary>Dates, amounts and .xlsx</summary>
                  <p>Each file's date format is chosen explicitly; two-digit years and impossible dates are problems. Amounts are exact; an amount with more decimals than the currency allows is a problem, never rounded. Workbooks are read as Excel displays them, so display rounding can hide digits that are stored.</p>
                </details>
                <FormatsAndLimits />
                <p className="note">Files stay in this browser. Decisions are kept only if you export a session backup or turn on saving in this browser; to continue later, load the same files again.</p>
              </div>
            )}
          </details>
        </div>
      </header>
    </>
  )
}
