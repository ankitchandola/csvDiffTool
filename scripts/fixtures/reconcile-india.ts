// Writes the Indian-format Reconcile fixtures in fixtures/reconcile/. Balances and running
// balances are computed here, so the files stay consistent when a transaction changes.
//   npx tsx scripts/fixtures/reconcile-india.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'

const OUT = path.join(import.meta.dirname, '..', '..', 'fixtures', 'reconcile')

// Paise, so every sum is exact.
type Paise = number

function indian(paise: Paise): string {
  const negative = paise < 0
  const text = String(Math.abs(paise)).padStart(3, '0')
  const whole = text.slice(0, -2)
  const last3 = whole.slice(-3)
  const rest = whole.slice(0, -3)
  const pairs: string[] = []
  for (let end = rest.length; end > 0; end -= 2) pairs.unshift(rest.slice(Math.max(0, end - 2), end))
  return `${negative ? '-' : ''}${[...pairs, last3].join(',')}.${text.slice(-2)}`
}

function csvLine(cells: string[]): string {
  return cells.map((c) => (/[",\n]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c)).join(',')
}

function writeCsv(name: string, lines: string[][]): void {
  writeFileSync(path.join(OUT, name), lines.map(csvLine).join('\r\n') + '\r\n')
}

const sum = (values: Paise[]) => values.reduce((a, b) => a + b, 0)

// Scenario A: an ICICI-style current-account statement against a Tally-style ledger of the
// same bank account. In Tally a bank ledger's debit is money in.
interface Line {
  day: number
  text: string
  ref: string
  amount: Paise
}

const ICICI: Line[] = [
  { day: 1, text: 'NEFT-RAJ ENTERPRISES-INV 2026/0412', ref: '', amount: 125_000_00 },
  { day: 2, text: 'UPI/624512345678/RAZORPAY SOFTWARE PVT LTD/SETTLEMENT', ref: '', amount: 18_450_00 },
  { day: 3, text: 'CLG/SHARMA STEEL WORKS', ref: '000145', amount: -45_000_00 },
  { day: 5, text: 'ACH D- TP ACH HDFC LIFE-POLICY 21456789', ref: '', amount: -12_500_00 },
  { day: 7, text: 'RTGS-SHREE CEMENTS LTD-ICIC0000045', ref: '', amount: -210_000_00 },
  { day: 10, text: 'BIL/ONL/000987654/BESCOM/SEP26', ref: '', amount: -8_732_00 },
  { day: 12, text: 'NEFT-GUPTA DISTRIBUTORS-PAYMENT', ref: '', amount: 64_000_00 },
  { day: 15, text: 'INF/INFT/SALARY SEP 2026/BULK', ref: '', amount: -180_000_00 },
  { day: 18, text: 'CHQ DEP/KOTAK MAHINDRA BANK/MEHTA TRADERS', ref: '000881', amount: 35_500_00 },
  { day: 20, text: 'GIB/GSTN CPIN 26092900012345', ref: '', amount: -27_540_00 },
  { day: 25, text: 'UPI/625898765432/PAYTM PAYMENTS SERVICES/SETTLEMENT', ref: '', amount: 18_450_00 },
  { day: 28, text: 'SMS CHARGES JUL-SEP 2026', ref: '', amount: -17_70 },
  { day: 30, text: 'INT.PD:01-07-2026 TO 30-09-2026', ref: '', amount: 1_245_00 },
]
const ICICI_OPENING: Paise = 250_000_00

const TALLY: Line[] = [
  { day: 1, text: 'Raj Enterprises', ref: 'Receipt 101', amount: 125_000_00 },
  { day: 2, text: 'Razorpay Software Pvt Ltd', ref: 'Receipt 102', amount: 18_450_00 },
  { day: 2, text: 'Sharma Steel Works (Chq 145)', ref: 'Payment 201', amount: -45_000_00 },
  { day: 4, text: 'HDFC Life Insurance', ref: 'Payment 202', amount: -12_500_00 },
  { day: 7, text: 'Shree Cements Ltd', ref: 'Payment 203', amount: -210_000_00 },
  { day: 9, text: 'BESCOM Electricity', ref: 'Payment 204', amount: -8_732_00 },
  { day: 12, text: 'Gupta Distributors', ref: 'Receipt 103', amount: 64_000_00 },
  { day: 15, text: 'Salary - Anil Kumar', ref: 'Payment 205', amount: -65_000_00 },
  { day: 15, text: 'Salary - Priya Nair', ref: 'Payment 206', amount: -60_000_00 },
  { day: 15, text: 'Salary - Ravi Shetty', ref: 'Payment 207', amount: -55_000_00 },
  { day: 17, text: 'Mehta Traders (Chq 881)', ref: 'Receipt 104', amount: 35_500_00 },
  { day: 20, text: 'GST Payable', ref: 'Payment 208', amount: -27_540_00 },
  { day: 25, text: 'Paytm Payments Services', ref: 'Receipt 105', amount: 18_450_00 },
  { day: 29, text: 'Verma Packaging (Chq 152)', ref: 'Payment 209', amount: -22_000_00 },
  { day: 30, text: 'Kapoor & Sons', ref: 'Receipt 106', amount: 40_000_00 },
]
const TALLY_OPENING: Paise = 250_000_00

function iciciStatement(): void {
  const dd = (day: number) => `${String(day).padStart(2, '0')}/09/2026`
  let balance = ICICI_OPENING
  const rows = ICICI.map((t, i) => {
    balance += t.amount
    const out = t.amount < 0 ? indian(-t.amount) : ''
    const into = t.amount > 0 ? indian(t.amount) : ''
    return [String(i + 1), dd(t.day), dd(t.day), t.ref, t.text, out, into, indian(balance)]
  })
  writeCsv('icici-statement-2026-09.csv', [
    ['DETAILED STATEMENT'],
    ['Transactions List - ACME TRADERS PVT LTD (INR) - 000405001234'],
    ['Transaction Date from 01/09/2026 to 30/09/2026'],
    ['S No.', 'Value Date', 'Transaction Date', 'Cheque Number', 'Transaction Remarks', 'Withdrawal Amount (INR )', 'Deposit Amount (INR )', 'Balance (INR )'],
    ...rows,
    ['Legends Used in Account Statement'],
    ['INF - Internet Fund Transfer; CLG - Clearing; BIL - Bill Payment; GIB - Government Internet Banking'],
  ])
}

// Tally writes 1-Sep-26 unless the company is set to four-digit years.
function tallyLedger(name: string, bankAccount: string, year: '2026' | '26'): void {
  const date = (day: number) => `${day}-Sep-${year}`
  const debits = TALLY.filter((t) => t.amount > 0)
  const credits = TALLY.filter((t) => t.amount < 0)
  const closing = TALLY_OPENING + sum(TALLY.map((t) => t.amount))
  writeCsv(name, [
    ['ACME TRADERS PVT LTD'],
    ['14 Industrial Area, Peenya, Bengaluru 560058'],
    [bankAccount],
    ['Ledger Account'],
    [`${date(1)} to ${date(30)}`],
    ['Date', 'Particulars', 'Vch Type', 'Vch No.', 'Debit', 'Credit'],
    ['', 'Opening Balance', '', '', indian(TALLY_OPENING), ''],
    ...TALLY.map((t) => {
      const [type, no] = t.ref.split(' ')
      return [date(t.day), t.text, type, no, t.amount > 0 ? indian(t.amount) : '', t.amount < 0 ? indian(-t.amount) : '']
    }),
    ['', '', '', '', indian(TALLY_OPENING + sum(debits.map((t) => t.amount))), indian(-sum(credits.map((t) => t.amount)))],
    ['', 'Closing Balance', '', '', '', indian(closing)],
  ])
}

// Scenario C: the same account's transactions as an SBI-style statement, with dates such
// as "1 Sep 2026", balances marked Cr, and unused amount cells holding a space.
function sbiStatement(): void {
  const date = (day: number) => `${day} Sep 2026`
  let balance = ICICI_OPENING
  const rows = ICICI.map((t) => {
    balance += t.amount
    return [date(t.day), date(t.day), t.text, t.ref, t.amount < 0 ? indian(-t.amount) : ' ', t.amount > 0 ? indian(t.amount) : ' ', `${indian(balance)} Cr`]
  })
  writeCsv('sbi-statement-2026-09.csv', [
    ['Account Name', ':ACME TRADERS PVT LTD'],
    ['Address', ':14 Industrial Area, Peenya, Bengaluru 560058'],
    ['Account Number', ':00000031234567890'],
    ['Account Description', ':CURRENT ACCOUNT'],
    ['Branch', ':PEENYA INDUSTRIAL AREA'],
    ['Balance as on 1 Sep 2026', `:${indian(ICICI_OPENING)} Cr`],
    ['Start Date', ':1 Sep 2026'],
    ['End Date', ':30 Sep 2026'],
    [],
    ['Txn Date', 'Value Date', 'Description', 'Ref No./Cheque No.', 'Debit', 'Credit', 'Balance'],
    ...rows,
    ['**This is a computer generated statement and does not require a signature.'],
  ])
}

// Scenario B: an HDFC-style .xlsx statement against a Zoho-style books export with one
// signed amount column.
const HDFC: Line[] = [
  { day: 1, text: 'NEFT CR-ICIC0000123-ZENITH SOFTWARE SOLUTIONS-INV 2026/114', ref: 'ICICN52026090112345', amount: 236_000_00 },
  { day: 3, text: 'POS 416600XXXXXX1234 AMAZON PAY INDIA', ref: '0000624600123456', amount: -3_499_00 },
  { day: 5, text: 'IMPS-624812345678-KAVYA DESIGNS-HDFC-XXXXXXX4521', ref: '0000624812345678', amount: -45_000_00 },
  { day: 5, text: 'IMPS-624812345679-KAVYA DESIGNS-HDFC-XXXXXXX4521', ref: '0000624812345679', amount: -45_000_00 },
  { day: 10, text: 'ATW-416600XXXXXX1234-S1ANMU12-MUMBAI', ref: '0000625300987654', amount: -10_000_00 },
  { day: 15, text: 'NEFT CR-SBIN0001234-NORTHWIND RETAIL-INV 2026/118', ref: 'SBIN526091512345', amount: 59_000_00 },
  { day: 30, text: 'FEE-ATM CASH WDL CHG 01-09-26', ref: '0000627300000123', amount: -23_60 },
]
const HDFC_OPENING: Paise = 100_000_00

const ZOHO: Line[] = [
  { day: 1, text: 'Payment received - Zenith Software Solutions', ref: 'INV-000114', amount: 236_000_00 },
  { day: 3, text: 'Expense - Amazon (office supplies)', ref: 'EXP-0231', amount: -3_499_00 },
  { day: 4, text: 'Bill payment - Kavya Designs', ref: 'BL-0091', amount: -45_000_00 },
  { day: 4, text: 'Bill payment - Kavya Designs', ref: 'BL-0092', amount: -45_000_00 },
  { day: 10, text: 'Transfer to Petty Cash', ref: 'TR-0017', amount: -10_000_00 },
  { day: 14, text: 'Payment received - Northwind Retail', ref: 'INV-000118', amount: 59_000_00 },
  { day: 29, text: 'Bill payment - Bluebird Logistics', ref: 'BL-0097', amount: -18_500_00 },
]

function hdfcStatement(): void {
  const rupees = (paise: Paise) => paise / 100
  const sheet = XLSX.utils.aoa_to_sheet([
    ['HDFC BANK Ltd.'],
    ['Page No .: 1'],
    ['NORTHSTAR STUDIO LLP'],
    ['Account No :50200012345678   CURRENT'],
    ['Statement From : 01/09/2026  To : 30/09/2026'],
    [],
    ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
  ])
  let balance = HDFC_OPENING
  const rows = HDFC.map((t) => {
    balance += t.amount
    const date = new Date(Date.UTC(2026, 8, t.day))
    return [date, t.text, t.ref, date, t.amount < 0 ? rupees(-t.amount) : null, t.amount > 0 ? rupees(t.amount) : null, rupees(balance)]
  })
  XLSX.utils.sheet_add_aoa(sheet, rows, { origin: -1, cellDates: true, dateNF: 'dd/mm/yyyy' })
  const debits = HDFC.filter((t) => t.amount < 0)
  const credits = HDFC.filter((t) => t.amount > 0)
  XLSX.utils.sheet_add_aoa(
    sheet,
    [
      [],
      ['STATEMENT SUMMARY :-'],
      ['Opening Balance', 'Dr Count', 'Cr Count', 'Debits', 'Credits', 'Closing Bal'],
      [rupees(HDFC_OPENING), debits.length, credits.length, rupees(-sum(debits.map((t) => t.amount))), rupees(sum(credits.map((t) => t.amount))), rupees(balance)],
    ],
    { origin: -1 },
  )
  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith('!') || typeof cell !== 'object') continue
    if (cell.t === 'd') cell.z = 'dd/mm/yyyy'
    if (cell.t === 'n' && !/^[BC]\d/.test(address)) cell.z = '#,##0.00'
  }
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Statement')
  writeFileSync(path.join(OUT, 'hdfc-statement-2026-09.xlsx'), XLSX.write(book, { type: 'buffer', bookType: 'xlsx', cellDates: true }))
}

function zohoBooks(): void {
  writeCsv('zoho-hdfc-transactions-2026-09.csv', [
    ['Date', 'Transaction Details', 'Reference#', 'Amount'],
    ...ZOHO.map((t) => [`2026-09-${String(t.day).padStart(2, '0')}`, t.text, t.ref, indian(t.amount)]),
  ])
}

mkdirSync(OUT, { recursive: true })
iciciStatement()
tallyLedger('tally-icici-ledger-2026-09.csv', 'ICICI Bank Current A/c 000405001234', '2026')
sbiStatement()
tallyLedger('tally-sbi-ledger-2026-09.csv', 'State Bank of India Current A/c 31234567890', '26')
hdfcStatement()
zohoBooks()

const closing = (opening: Paise, lines: Line[]) => indian(opening + sum(lines.map((t) => t.amount)))
console.log(`A: bank ${indian(ICICI_OPENING)} → ${closing(ICICI_OPENING, ICICI)}; books ${indian(TALLY_OPENING)} → ${closing(TALLY_OPENING, TALLY)}`)
console.log(`B: bank ${indian(HDFC_OPENING)} → ${closing(HDFC_OPENING, HDFC)}; books ${indian(HDFC_OPENING)} → ${closing(HDFC_OPENING, ZOHO)}`)
