import { expect, type Locator, type Page, test } from '@playwright/test'
import path from 'node:path'
import { choose, classifyAll } from './reconcile-helpers'

// Indian-format statements and ledger exports written by scripts/fixtures/reconcile-india.ts.
const fixture = (name: string) => path.join(import.meta.dirname, '..', 'fixtures', 'reconcile', name)

function mappingFieldset(page: Page, title: string): Locator {
  return page.locator('fieldset').filter({ has: page.locator('legend', { hasText: new RegExp(`^${title}$`) }) })
}

async function load(page: Page, side: 'bank statement' | 'books', file: string, headerRecord: number, skipTrailing: number, records: number) {
  const panel = page.locator('section.file-panel', { hasText: side === 'books' ? 'Your ledger' : 'Bank statement' })
  await panel.getByLabel(`Choose ${side}`).setInputFiles(fixture(file))
  await panel.getByLabel('Header is record').fill(String(headerRecord))
  await panel.getByLabel('Skip records at the end').fill(String(skipTrailing))
  await expect(panel.locator('.file-stats')).toContainText(`${records} records`)
}

async function confirmAllSuggestions(page: Page) {
  const confirm = page.locator('.review-row').getByRole('button', { name: 'Confirm', exact: true })
  while ((await confirm.count()) > 0) {
    const before = await confirm.count()
    await confirm.first().click()
    await expect(confirm).not.toHaveCount(before)
  }
  await expect(page.getByText('No open suggestions.')).toBeVisible()
}

test('ICICI-style statement against a Tally-style ledger', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /Reconcile/ }).click()
  await load(page, 'bank statement', 'icici-statement-2026-09.csv', 4, 2, 13)
  // The ledger's opening-balance line sits right below the header, so it is read as data.
  await load(page, 'books', 'tally-icici-ledger-2026-09.csv', 6, 2, 16)
  await page.getByRole('button', { name: 'Map dates and amounts' }).click()

  await page.getByLabel('Currency').fill('INR')
  await choose(page, 'Bank statement date column', 'Transaction Date')
  await choose(page, 'Bank statement date format', 'DD/MM/YYYY')
  await page.getByRole('radiogroup', { name: 'Bank statement amount layout' }).getByLabel(/Separate/).check()
  await choose(page, 'Bank statement money-in column', 'Deposit Amount (INR )')
  await choose(page, 'Bank statement money-out column', 'Withdrawal Amount (INR )')
  await mappingFieldset(page, 'Bank statement').getByLabel(/thousands separators/).check()
  await choose(page, 'Bank statement reference column', 'Cheque Number')
  await choose(page, 'Bank statement description column', 'Transaction Remarks')
  await choose(page, 'Bank statement running balance column', 'Balance (INR )')
  await choose(page, 'Books date column', 'Date')
  await choose(page, 'Books date format', 'DD-Mon-YYYY')
  await page.getByRole('radiogroup', { name: 'Books amount layout' }).getByLabel(/Separate/).check()
  await choose(page, 'Books money-in column', 'Debit')
  await choose(page, 'Books money-out column', 'Credit')
  await mappingFieldset(page, 'Books').getByLabel(/thousands separators/).check()
  await choose(page, 'Books reference column', 'Vch No.')
  await choose(page, 'Books description column', 'Particulars')
  await page.getByLabel('Period start').fill('2026-09-01')
  await page.getByLabel('Period end').fill('2026-09-30')
  await page.getByLabel('Bank opening balance').fill('2,50,000.00')
  await page.getByLabel('Bank closing balance').fill('28,855.30')
  await page.getByLabel('Books opening balance').fill('2,50,000.00')
  await page.getByLabel('Books closing balance').fill('45,628.00')

  await page.getByRole('button', { name: 'Check mapping' }).click()
  const check = page.getByRole('region', { name: 'Mapping check' })
  await expect(check.getByText('13 records: 13 valid (6 money in, 7 money out) · 0 zero · 0 records with problems')).toBeVisible()
  await expect(check.getByText('16 records: 15 valid (6 money in, 9 money out) · 0 zero · 1 record with problems')).toBeVisible()
  await expect(check.getByText('The date is empty')).toBeVisible()

  await page.getByRole('button', { name: 'Find suggestions' }).click()
  const metrics = page.locator('.metric-grid')
  await expect(metrics.locator('.metric', { hasText: 'Candidate pairs found' })).toContainText('10')
  await expect(metrics.locator('.metric', { hasText: 'Unique groups' })).toContainText('10')
  await expect(metrics.locator('.metric', { hasText: 'Without a candidate' })).toContainText('8')
  await confirmAllSuggestions(page)

  const panel = page.getByRole('region', { name: 'Reconciliation status' })
  await expect(panel).toContainText('Bank running balance: consistent with every record')
  // The bulk salary payment is one bank debit against three ledger entries: grouped
  // matching is not built yet, so all four stay unmatched and the bridge explains them.
  await page.getByRole('tab', { name: /^Unmatched/ }).click()
  await expect(page.locator('.review-row', { hasText: 'INF/INFT/SALARY SEP 2026/BULK' })).toBeVisible()
  await expect(page.locator('.review-row', { hasText: 'Salary - ' })).toHaveCount(3)
  await expect(page.getByRole('tab', { name: /^Unmatched/ })).toContainText('8')
  await classifyAll(page)
  // The opening-balance line can't be skipped and is not a transaction, so the books
  // source does not validate and completion stays blocked.
  await expect(panel).toContainText('Books: 1 invalid record has no trustworthy amount')
  await expect(panel.getByRole('button', { name: 'Mark reconciliation complete' })).toBeDisabled()
})

test('HDFC-style .xlsx statement against a Zoho-style books export', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /Reconcile/ }).click()
  // Five preamble records; the blank row before the header is not counted.
  await load(page, 'bank statement', 'hdfc-statement-2026-09.xlsx', 6, 3, 7)
  await load(page, 'books', 'zoho-hdfc-transactions-2026-09.csv', 1, 0, 7)
  await page.getByRole('button', { name: 'Map dates and amounts' }).click()

  await page.getByLabel('Currency').fill('INR')
  await choose(page, 'Bank statement date column', 'Date')
  await choose(page, 'Bank statement date format', 'DD/MM/YYYY')
  await page.getByRole('radiogroup', { name: 'Bank statement amount layout' }).getByLabel(/Separate/).check()
  await choose(page, 'Bank statement money-in column', 'Deposit Amt.')
  await choose(page, 'Bank statement money-out column', 'Withdrawal Amt.')
  await mappingFieldset(page, 'Bank statement').getByLabel(/thousands separators/).check()
  await choose(page, 'Bank statement reference column', 'Chq./Ref.No.')
  await choose(page, 'Bank statement description column', 'Narration')
  await choose(page, 'Bank statement running balance column', 'Closing Balance')
  await choose(page, 'Books date column', 'Date')
  await choose(page, 'Books date format', 'YYYY-MM-DD')
  await choose(page, 'Books amount column', 'Amount')
  await mappingFieldset(page, 'Books').getByLabel(/thousands separators/).check()
  await choose(page, 'Books reference column', 'Reference#')
  await choose(page, 'Books description column', 'Transaction Details')
  await page.getByLabel('Period start').fill('2026-09-01')
  await page.getByLabel('Period end').fill('2026-09-30')
  await page.getByLabel('Bank opening balance').fill('1,00,000.00')
  await page.getByLabel('Bank closing balance').fill('2,91,477.40')
  await page.getByLabel('Books opening balance').fill('1,00,000.00')
  await page.getByLabel('Books closing balance').fill('2,73,001.00')

  await page.getByRole('button', { name: 'Check mapping' }).click()
  const check = page.getByRole('region', { name: 'Mapping check' })
  await expect(check.getByText('7 records: 7 valid (2 money in, 5 money out) · 0 zero · 0 records with problems')).toHaveCount(2)
  await expect(check.getByText('Bank record 1 · row 8')).toBeVisible()

  await page.getByRole('button', { name: 'Find suggestions' }).click()
  const metrics = page.locator('.metric-grid')
  await expect(metrics.locator('.metric', { hasText: 'Candidate pairs found' })).toContainText('8')
  await expect(metrics.locator('.metric', { hasText: /^\d+Groups$/ })).toContainText('5')
  await expect(metrics.locator('.metric', { hasText: 'Unique groups' })).toContainText('4')
  // Two IMPS payments of the same amount on one day carry different reference numbers, so
  // they compete as an ordinary group rather than as a set to confirm together.
  await expect(page.getByText('2 bank transactions and 2 books transactions compete through 4 pairs; no unique pairing').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Confirm set…' })).toHaveCount(0)
  await confirmAllSuggestions(page)

  await classifyAll(page)
  const panel = page.getByRole('region', { name: 'Reconciliation status' })
  await expect(panel).toContainText('Bank running balance: consistent with every record')
  await panel.getByRole('button', { name: 'Mark reconciliation complete' }).click()
  await expect(panel).toContainText('Reconciliation completed: yes')
})
