import { expect, type Page, test } from '@playwright/test'
import * as XLSX from 'xlsx'
import { choose, setUpMonth as setUp } from './reconcile-helpers'

const BANK_SEP = 'date,amount,ref,memo\n11/09/2026,300.00,,Receipt\n'
const BOOKS_SEP = 'date,amount,ref,memo\n2026-09-10,300.00,,Receipt\n2026-09-15,-50.00,CHQ102,Cheque 102 issued\n2026-09-29,-200.00,CHQ101,Cheque 101 issued\n'
const BANK_OCT = 'date,amount,ref,memo,balance\n02/10/2026,-200.00,CHQ101,Cheque 101 cleared,1100.00\n20/10/2026,-50.00,CHQ102,Cheque 102 cleared,1050.00\n31/10/2026,-10.00,,Bank charge,1040.00\n'
const BOOKS_OCT = 'date,amount,ref,memo\n2026-10-30,500.00,,Receipt\n'

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

test('loading a backup without opening items drops the ones imported before', async ({ page }) => {
  test.setTimeout(60_000)
  const october = { bank: 'date,amount,ref,memo\n02/10/2026,-200.00,CHQ101,Cheque 101 cleared\n', books: 'date,amount,ref,memo\n2026-10-30,500.00,,Receipt\n' }
  await setUp(page, october, ['2026-10-01', '2026-10-31'], ['1300.00', '1100.00', '1050.00', '1550.00'])
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await expect(page.getByRole('heading', { name: 'Review pairs' })).toBeVisible()
  const backup = (await downloaded(page, () => page.getByRole('button', { name: 'Export session backup' }).click())).toString()
  expect(JSON.parse(backup).opening).toEqual([])

  const outstanding = JSON.stringify({
    format: 'reconciliation-outstanding', version: 1, exportedAt: '2026-10-01T00:00:00Z', sessionId: 'sep', account: '', currency: 'INR', minorUnits: 2,
    period: { start: '2026-09-01', end: '2026-09-30' },
    items: [{ lineage: `books|${'2'.repeat(64)}|3`, side: 'books', date: '2026-09-29', amount: '-200.00', direction: 'out', reference: 'CHQ101', description: 'Cheque 101 issued', origin: { sessionId: 'sep', period: { start: '2026-09-01', end: '2026-09-30' }, fileName: 'books-sep.csv', fingerprint: '2'.repeat(64), recordNumber: 3 } }],
    cleared: [],
  })
  await page.getByRole('button', { name: 'Edit mapping' }).click()
  await page.getByLabel('Import outstanding items file').setInputFiles({ name: 'outstanding.json', mimeType: 'application/json', buffer: Buffer.from(outstanding) })
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await expect(page.locator('.review-row', { hasText: 'Carried · Books record 3' }).first()).toBeVisible()

  await page.getByLabel('Import session file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) })
  await expect(page.getByText(/Loaded a session/)).toBeVisible()
  await page.getByRole('button', { name: 'Map dates and amounts' }).click()
  await expect(page.locator('.opening-files')).toHaveCount(0)
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await expect(page.getByRole('heading', { name: 'Review pairs' })).toBeVisible()
  await page.getByRole('tab', { name: /^Unmatched/ }).click()
  await expect(page.locator('.review-row').first()).toBeVisible()
  await expect(page.getByText(/Carried ·/)).toHaveCount(0)
})
