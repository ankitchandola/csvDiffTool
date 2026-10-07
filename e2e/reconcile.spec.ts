import { expect, test, type Page } from '@playwright/test'

const BANK = [
  'Account,1234',
  'Period,Sep 2026',
  'Date,Details,Credit,Debit,Ref',
  '01/09/2026,Salary,"50,000.00",,',
  '02/09/2026,Rent,,"12,000.00",CHQ-101',
  '02/09/2026,Subscription,,9.99,',
  '03/09/2026,Bad row,,abc,',
  'Closing balance,,,,',
].join('\n')

const BOOKS = ['date,memo,amount,ref', '2026-08-31,Salary in,50000,', '2026-09-02,Rent cheque,-12000,CHQ-101', '2026-09-03,Sub,-9.99,', '2026-09-03,Sub dup,-9.99,', '2026-09-20,Unpaid,-75,'].join('\n')

// The dropdown closes when the page scrolls, and the scroll event from Playwright's
// scroll-into-view arrives a frame after its click; scroll first and let that event pass.
async function choose(page: Page, label: string, option: string) {
  const trigger = page.getByRole('combobox', { name: label, exact: true })
  await trigger.scrollIntoViewIfNeeded()
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await trigger.click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

async function loadAndMap(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Reconcile/ }).click()
  await expect(page.getByRole('heading', { name: 'Reconcile a bank statement' })).toBeVisible()
  await expect(page.locator('.experimental-note')).toContainText('Experimental and suggestion-only')
  const bank = page.locator('section.file-panel', { hasText: 'Bank statement' })
  await bank.getByLabel('Choose bank statement').setInputFiles({ name: 'bank.csv', mimeType: 'text/csv', buffer: Buffer.from(BANK) })
  await expect(bank.getByText(/Expected 5 fields|problem/).first()).toBeVisible()
  await bank.getByLabel('Header is record').fill('3')
  await bank.getByLabel('Skip records at the end').fill('1')
  await expect(bank.locator('.file-stats')).toContainText('4 records')
  await expect(bank.getByText(/Skipped 2 records above the header and 1 record at the end/)).toBeVisible()
  const books = page.locator('section.file-panel', { hasText: 'Your ledger' })
  await books.getByLabel('Choose books').setInputFiles({ name: 'books.csv', mimeType: 'text/csv', buffer: Buffer.from(BOOKS) })
  await expect(books.locator('.file-stats')).toContainText('5 records')
  await page.getByRole('button', { name: 'Map dates and amounts' }).click()
  await expect(page.getByRole('heading', { name: 'Map dates and amounts' })).toBeFocused()

  await page.getByLabel('Currency').fill('INR')
  await choose(page, 'Bank statement date column', 'Date')
  await choose(page, 'Bank statement date format', 'DD/MM/YYYY')
  await page.getByRole('radiogroup', { name: 'Bank statement amount layout' }).getByLabel(/Separate/).check()
  await choose(page, 'Bank statement money-in column', 'Credit')
  await choose(page, 'Bank statement money-out column', 'Debit')
  await page.locator('fieldset', { hasText: 'Bank statement' }).getByLabel(/thousands separators/).check()
  await choose(page, 'Bank statement reference column', 'Ref')
  await choose(page, 'Bank statement description column', 'Details')
  await choose(page, 'Books date column', 'date')
  await choose(page, 'Books date format', 'YYYY-MM-DD')
  await choose(page, 'Books amount column', 'amount')
  await choose(page, 'Books reference column', 'ref')
  await choose(page, 'Books description column', 'memo')
}

test('reconcile flow: layout, mapping check, suggestions and review tabs', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await loadAndMap(page)
  await page.getByRole('button', { name: 'Check mapping' }).click()
  const check = page.getByRole('region', { name: 'Mapping check' })
  await expect(check.getByText(/4 rows: 3 valid \(1 money in, 2 money out\)/)).toBeVisible()
  await expect(check.getByText('Money out: "abc" is not a number in the chosen format')).toBeVisible()
  await expect(check.getByText('Bank record 2 · line 5')).toBeVisible()

  await page.getByLabel(/same identifier/).check()
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await expect(page.getByRole('heading', { name: 'Suggested pairs' })).toBeFocused()
  await expect(page.locator('.metric strong')).toHaveText(['4', '3', '2', '1'])
  await expect(page.getByText('Amount exact; bank date 1 day before books; reference absent on both sides.').first()).toBeVisible()
  await expect(page.getByText('Amount exact; same date; reference matched.')).toBeVisible()
  await expect(page.getByText(/1 bank transaction and 2 books transactions compete through 2 pairs/).first()).toBeVisible()

  await page.getByLabel('Search this tab').fill('chq-101')
  await expect(page.getByText('1 pair match.')).toBeVisible()
  await page.getByLabel('Search this tab').fill('')

  await page.getByRole('tab', { name: /No candidate/ }).click()
  await expect(page.locator('#recon-panel').getByText('Unpaid')).toBeVisible()
  await page.getByRole('tab', { name: /Problems/ }).click()
  await expect(page.locator('#recon-panel').getByText('Bank record 4 · line 7')).toBeVisible()
  await expect(page.locator('.experimental-note')).toContainText('nothing here shows that an account is reconciled')
  await expect(page.getByRole('button', { name: /confirm/i })).toHaveCount(0)

  await page.getByRole('button', { name: 'Edit mapping' }).click()
  await page.getByLabel('Bank date up to this many days after books').fill('0')
  await expect(page.getByText('Setup changed. Find suggestions again.')).toBeVisible()
  await expect(page.getByRole('button', { name: '3 Review' })).toBeDisabled()
  expect(errors).toEqual([])
})

test('switching modes keeps each mode’s files', async ({ page }) => {
  await page.goto('/')
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
    await expect(page.getByRole('heading', { name: 'Suggested pairs' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}
