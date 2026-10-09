import { expect, test } from './reconcile-test'
import * as XLSX from 'xlsx'
import { BOOKS, choose, loadAndMap, setUpMonth } from './reconcile-helpers'

test('reconcile flow: layout, mapping check, suggestions and review tabs', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await loadAndMap(page)
  await page.getByRole('button', { name: /^Check (mapping|again)$/ }).click()
  const check = page.getByRole('region', { name: 'Mapping check' })
  await expect(check.getByText(/4 records: 3 valid \(1 money in, 2 money out\)/)).toBeVisible()
  await expect(check.getByText('Money out: "abc" is not a number in the chosen format')).toBeVisible()
  await expect(check.getByText('Bank record 2 · line 5')).toBeVisible()

  await page.getByLabel(/same identifier/).check()
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await expect(page.getByRole('heading', { name: 'Review matches' })).toBeFocused()
  await expect(page.locator('.metric strong')).toHaveText(['4', '1', '1'])
  await expect(page.getByText('Amount exact; bank date 1 day before books; reference absent on both sides.').first()).toBeVisible()
  await expect(page.getByText('Amount exact; same date; reference matched.')).toBeVisible()
  await expect(page.getByText(/1 bank transaction and 2 books transactions compete through 2 pairs/).first()).toBeVisible()

  await page.getByLabel('Search this tab').fill('chq-101')
  await expect(page.getByText('1 pair shown for these filters.')).toBeVisible()
  await page.getByLabel('Search this tab').fill('')

  await page.getByRole('tab', { name: /Unmatched/ }).click()
  await page.getByLabel('Search this tab').fill('Unpaid')
  await expect(page.locator('#recon-panel').getByText('Unpaid')).toBeVisible()
  await page.getByLabel('Search this tab').fill('')
  await page.getByRole('tab', { name: /Problems/ }).click()
  await expect(page.locator('#recon-panel').getByText('Bank record 4 · line 7')).toBeVisible()

  await page.getByRole('button', { name: 'Edit mapping' }).click()
  await expect(page.locator('.experimental-note')).toContainText('counts as completed only when every status is earned and you mark it complete')
  await page.getByLabel('Bank date up to this many days after books').fill('0')
  await expect(page.getByText('Setup changed. Find suggestions again.')).toBeVisible()
  await expect(page.getByRole('button', { name: '3 Review' })).toBeDisabled()
  expect(errors).toEqual([])
})

test('references are compared only while both sides map a reference column', async ({ page }) => {
  await loadAndMap(page)
  const shared = page.getByLabel(/same identifier/)
  await shared.check()
  await choose(page, 'Books reference column', 'None')
  await expect(shared).not.toBeChecked()
  await expect(shared).toBeDisabled()
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await page.getByText('How the suggestions were found').click()
  await expect(page.getByText(/references for context only/)).toBeVisible()
})

test('switching modes keeps each mode’s files', async ({ page }) => {
  await page.goto('./')
  await page.getByLabel('Choose old file').setInputFiles({ name: 'baseline.csv', mimeType: 'text/csv', buffer: Buffer.from('id,v\n1,a\n') })
  await page.getByRole('button', { name: /Reconcile/ }).click()
  await page.getByLabel('Choose books').setInputFiles({ name: 'books.csv', mimeType: 'text/csv', buffer: Buffer.from(BOOKS) })
  await page.getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(page.getByText('baseline.csv', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /Reconcile/ }).click()
  await expect(page.getByText('books.csv', { exact: true })).toBeVisible()
})

for (const width of [390, 768]) {
  test(`reconcile review fits ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await loadAndMap(page)
    await page.getByRole('button', { name: 'Find suggestions' }).click()
    await expect(page.getByRole('heading', { name: 'Review matches' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}

// Reading this many rows takes seconds, so Cancel lands mid-task. Matching is capped
// by its candidate budget and finishes too quickly to cancel reliably; Cancel runs the
// same code whichever task is running.
function bigBankStatement(): Buffer {
  return Buffer.from('Account,1234\nPeriod,Sep 2026\nDate,Details,Credit,Debit,Ref\n' + '01/09/2026,x,100.00,,\n'.repeat(600_000) + 'Closing,,,,\n')
}

test.describe('cancel', () => {
  test.describe.configure({ mode: 'serial', timeout: 90_000 })

  test('while reading stops the work and asks for the file again', async ({ page }) => {
    await page.goto('./')
    await page.getByRole('button', { name: /Reconcile/ }).click()
    const bank = page.locator('section.file-panel', { hasText: 'Bank statement' })
    await bank.getByLabel('Header is record').fill('3')
    await bank.getByLabel('Skip records at the end').fill('1')
    await bank.getByLabel('Choose bank statement').setInputFiles({ name: 'bank.csv', mimeType: 'text/csv', buffer: bigBankStatement() })
    await expect(page.locator('.activity-row', { hasText: 'Reading bank statement' })).toBeVisible()
    await page.locator('.activity').getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.locator('.activity')).toHaveCount(0)
    await expect(bank.getByRole('alert')).toContainText('Cancelled')
    await expect(page.getByRole('button', { name: 'Map dates and amounts' })).toBeDisabled()
    await bank.getByRole('button', { name: 'Read bank.csv again' }).click()
    await expect(bank.locator('.file-stats')).toContainText('600,000 records', { timeout: 60_000 })
  })

  test('also asks again for a file whose problems were in the cancelled worker', async ({ page }) => {
    await page.goto('./')
    await page.getByRole('button', { name: /Reconcile/ }).click()
    const books = page.locator('section.file-panel', { hasText: 'Your ledger' })
    await books.getByLabel('Choose books').setInputFiles({ name: 'books.csv', mimeType: 'text/csv', buffer: Buffer.from('date,amount\n1,2,3\n') })
    await expect(books.getByText(/problem/).first()).toBeVisible()
    const bank = page.locator('section.file-panel', { hasText: 'Bank statement' })
    await bank.getByLabel('Header is record').fill('3')
    await bank.getByLabel('Skip records at the end').fill('1')
    await bank.getByLabel('Choose bank statement').setInputFiles({ name: 'bank.csv', mimeType: 'text/csv', buffer: bigBankStatement() })
    await expect(page.locator('.activity-row', { hasText: 'Reading bank statement' })).toBeVisible()
    await page.locator('.activity').getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(books.getByRole('button', { name: 'Read books.csv again' })).toBeVisible()
    await books.getByRole('button', { name: 'Read books.csv again' }).click()
    await expect(books.getByText('Expected 2 fields, found 3')).toBeVisible()
  })

  test('keeps the chosen worksheet when a cancelled file is read again with new settings', async ({ page }) => {
    await page.goto('./')
    await page.getByRole('button', { name: /Reconcile/ }).click()
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['date', 'amount'], ['2026-09-01', 1]]), 'First')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['date', 'amount'], ['2026-09-01', 1], ['2026-09-02', 2]]), 'Second')
    const books = page.locator('section.file-panel', { hasText: 'Your ledger' })
    await books.getByLabel('Choose books').setInputFiles({
      name: 'books.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })),
    })
    await expect(books.locator('.file-stats')).toContainText('sheet “First”')
    await choose(page, 'Sheet in books', 'Second')
    await expect(books.locator('.file-stats')).toContainText('sheet “Second”')
    const bank = page.locator('section.file-panel', { hasText: 'Bank statement' })
    await bank.getByLabel('Choose bank statement').setInputFiles({ name: 'bank.csv', mimeType: 'text/csv', buffer: bigBankStatement() })
    await expect(page.locator('.activity-row', { hasText: 'Reading bank statement' })).toBeVisible()
    await page.locator('.activity').getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(books.getByRole('button', { name: 'Read books.xlsx (sheet “Second”) again' })).toBeVisible()
    await choose(page, 'Books CSV delimiter', 'Semicolon')
    await expect(books.locator('.file-stats')).toContainText('sheet “Second”')
    await expect(books.locator('.file-stats')).toContainText('2 records')
  })

  test('drops earlier suggestions and needs both files read again', async ({ page }) => {
    await loadAndMap(page)
    await page.getByRole('button', { name: 'Find suggestions' }).click()
    await expect(page.getByRole('heading', { name: 'Review matches' })).toBeVisible()
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    const bank = page.locator('section.file-panel', { hasText: 'Bank statement' })
    await bank.getByLabel('Choose bank statement').setInputFiles({ name: 'bank.csv', mimeType: 'text/csv', buffer: bigBankStatement() })
    await expect(page.locator('.activity-row', { hasText: 'Reading bank statement' })).toBeVisible()
    await page.locator('.activity').getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Read bank.csv again' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Read books.csv again' })).toBeVisible()
    await expect(page.getByRole('button', { name: '3 Review' })).toBeDisabled()
    await expect(page.getByRole('button', { name: '2 Map' })).toBeDisabled()
  })

  // Matching 600,000 transactions a side takes long enough to cancel once it shows.
  test('while finding suggestions stops the search, and finding them again works', async ({ page }) => {
    test.setTimeout(180_000)
    const rows = (date: (i: number) => string) => {
      const lines = ['date,amount,ref,memo']
      for (let i = 0; i < 600_000; i++) lines.push(`${date(i)},${(i + 1) / 100},,Row ${i}`)
      return lines.join('\n')
    }
    const day = (i: number) => String((i % 28) + 1).padStart(2, '0')
    await setUpMonth(page, { bank: rows((i) => `${day(i)}/09/2026`), books: rows((i) => `2026-09-${day(i)}`) }, ['2026-09-01', '2026-09-30'], ['0', '0', '0', '0'])
    await page.getByRole('button', { name: 'Find suggestions' }).click()
    await expect(page.locator('.activity-row', { hasText: 'Finding suggestions' })).toBeVisible({ timeout: 120_000 })
    await page.locator('.activity').getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.locator('.activity')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Reconcile a bank statement' })).toBeVisible()
    await expect(page.getByRole('button', { name: '3 Review' })).toBeDisabled()
    for (const file of ['bank.csv', 'books.csv']) await page.getByRole('button', { name: `Read ${file} again` }).click()
    await page.getByRole('button', { name: 'Map dates and amounts' }).click()
    await page.getByRole('button', { name: 'Find suggestions' }).click()
    await expect(page.getByRole('heading', { name: 'Review matches' })).toBeVisible({ timeout: 120_000 })
    await expect(page.locator('.metric', { hasText: 'candidate pairs' })).toContainText('600,000')
  })
})
