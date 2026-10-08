import { expect, type Page, test } from '@playwright/test'
import * as XLSX from 'xlsx'
import { choose } from './reconcile-helpers'

const BANK_SEP = 'date,amount,ref,memo\n11/09/2026,300.00,,Receipt\n'
const BOOKS_SEP = 'date,amount,ref,memo\n2026-09-10,300.00,,Receipt\n2026-09-15,-50.00,CHQ102,Cheque 102 issued\n2026-09-29,-200.00,CHQ101,Cheque 101 issued\n'
const BANK_OCT = 'date,amount,ref,memo,balance\n02/10/2026,-200.00,CHQ101,Cheque 101 cleared,1100.00\n20/10/2026,-50.00,CHQ102,Cheque 102 cleared,1050.00\n31/10/2026,-10.00,,Bank charge,1040.00\n'
const BOOKS_OCT = 'date,amount,ref,memo\n2026-10-30,500.00,,Receipt\n'

async function setUp(page: Page, files: { bank: string; books: string }, period: [string, string], balances: [string, string, string, string]) {
  await page.goto('/')
  await page.getByRole('button', { name: /Reconcile/ }).click()
  await page.getByLabel('Choose bank statement').setInputFiles({ name: 'bank.csv', mimeType: 'text/csv', buffer: Buffer.from(files.bank) })
  await page.getByLabel('Choose books').setInputFiles({ name: 'books.csv', mimeType: 'text/csv', buffer: Buffer.from(files.books) })
  await page.getByRole('button', { name: 'Map dates and amounts' }).click()
  await page.getByLabel('Currency').fill('INR')
  await choose(page, 'Bank statement date column', 'date')
  await choose(page, 'Bank statement date format', 'DD/MM/YYYY')
  await choose(page, 'Bank statement amount column', 'amount')
  await choose(page, 'Bank statement reference column', 'ref')
  await choose(page, 'Bank statement description column', 'memo')
  await choose(page, 'Books date column', 'date')
  await choose(page, 'Books date format', 'YYYY-MM-DD')
  await choose(page, 'Books amount column', 'amount')
  await choose(page, 'Books reference column', 'ref')
  await choose(page, 'Books description column', 'memo')
  await page.getByLabel(/same identifier/).check()
  await page.getByLabel('Bank date up to this many days after books').fill('40')
  await page.getByLabel('Period start').fill(period[0])
  await page.getByLabel('Period end').fill(period[1])
  await page.getByLabel('Bank opening balance').fill(balances[0])
  await page.getByLabel('Bank closing balance').fill(balances[1])
  await page.getByLabel('Books opening balance').fill(balances[2])
  await page.getByLabel('Books closing balance').fill(balances[3])
}

async function downloaded(page: Page, click: () => Promise<void>): Promise<Buffer> {
  const event = page.waitForEvent('download')
  await click()
  const chunks: Buffer[] = []
  for await (const chunk of await (await event).createReadStream()) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function classifyAll(page: Page) {
  await page.getByRole('tab', { name: /^Unmatched/ }).click()
  await expect(page.locator('.review-row').first()).toBeVisible()
  for (const row of await page.locator('.review-row').all()) {
    await row.focus()
    await page.keyboard.press('o')
    await expect(row.locator('.chip')).toBeVisible()
  }
}

test('September’s outstanding cheques carry into October, clear there, and only new items carry on', async ({ page }) => {
  // Two full months through the UI; slower when the suite runs its large-file tests alongside.
  test.setTimeout(60_000)
  const panel = page.getByRole('region', { name: 'Reconciliation status' })

  await setUp(page, { bank: BANK_SEP, books: BOOKS_SEP }, ['2026-09-01', '2026-09-30'], ['1000.00', '1300.00', '1000.00', '1050.00'])
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await page.locator('.review-row', { hasText: 'Receipt' }).first().getByRole('button', { name: 'Confirm' }).click()
  await classifyAll(page)
  await panel.getByRole('button', { name: 'Mark reconciliation complete' }).click()
  await expect(panel).toContainText('Reconciliation completed: yes')
  const download = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export outstanding items' }).click()
  const september = await (await download).createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of september) chunks.push(Buffer.from(chunk))
  const outstanding = Buffer.concat(chunks).toString()
  expect(JSON.parse(outstanding).items.map((i: { amount: string }) => i.amount)).toEqual(['-50.00', '-200.00'])

  await page.reload()
  await setUp(page, { bank: BANK_OCT, books: BOOKS_OCT }, ['2026-10-01', '2026-10-31'], ['1300.00', '1040.00', '1050.00', '1550.00'])
  await choose(page, 'Bank statement running balance column', 'balance')
  await page.getByLabel('Import outstanding items file').setInputFiles({ name: 'outstanding-2026-09-30.json', mimeType: 'application/json', buffer: Buffer.from(outstanding) })
  await expect(page.locator('.opening-files')).toContainText('2026-09-01 to 2026-09-30 · 2 outstanding items')
  await page.getByRole('button', { name: 'Check mapping' }).click()
  await expect(page.getByText(/Opening items: 0 bank items and 2 books items carried/)).toBeVisible()
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  for (const cheque of ['Cheque 101', 'Cheque 102']) {
    const row = page.locator('.review-row', { hasText: `${cheque} cleared` }).first()
    await expect(row).toContainText('Carried · Books record')
    await row.getByRole('button', { name: 'Confirm' }).click()
  }
  await classifyAll(page)
  await expect(panel).toContainText('Bank running balance: consistent with every row')
  await panel.getByRole('button', { name: 'Mark reconciliation complete' }).click()
  await expect(panel).toContainText('Reconciliation completed: yes')
  const next = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export outstanding items' }).click()
  const october = await (await next).createReadStream()
  const parts: Buffer[] = []
  for await (const chunk of october) parts.push(Buffer.from(chunk))
  const carried = JSON.parse(Buffer.concat(parts).toString())
  expect(carried.items.map((i: { description: string }) => i.description)).toEqual(['Bank charge', 'Receipt'])
  expect(carried.cleared).toHaveLength(2)

  const report = JSON.parse((await downloaded(page, () => panel.getByRole('button', { name: 'Report (JSON)' }).click())).toString())
  expect(report.statuses.completed).toEqual({ earned: true, reasons: [] })
  expect(report.matches).toHaveLength(2)
  expect(report.running.bank).toBe('consistent with every row')
  const workbook = XLSX.read(await downloaded(page, () => panel.getByRole('button', { name: 'Report (Excel)' }).click()))
  expect(workbook.SheetNames).toEqual(['Summary', 'Matches', 'Outstanding', 'Problems', 'Decisions'])
  expect(XLSX.utils.sheet_to_json<string[]>(workbook.Sheets.Summary, { header: 1 })).toContainEqual(['Reconciliation completed', 'Yes'])
})

test('an outstanding-items file from the same period is refused at the mapping check', async ({ page }) => {
  await setUp(page, { bank: BANK_SEP, books: BOOKS_SEP }, ['2026-09-01', '2026-09-30'], ['1000.00', '1300.00', '1000.00', '1050.00'])
  const file = JSON.stringify({ format: 'reconciliation-outstanding', version: 1, exportedAt: '2026-10-01T00:00:00Z', sessionId: 's', account: '', currency: 'INR', minorUnits: 2, period: { start: '2026-09-01', end: '2026-09-30' }, items: [], cleared: [] })
  await page.getByLabel('Import outstanding items file').setInputFiles({ name: 'same.json', mimeType: 'application/json', buffer: Buffer.from(file) })
  await page.getByRole('button', { name: 'Check mapping' }).click()
  await expect(page.getByRole('alert')).toContainText("same.json: The file's period ends 2026-09-30, not before this session's period starts (2026-09-01)")
})
