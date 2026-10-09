import { expect, type Page } from '@playwright/test'

export const BANK = [
  'Account,1234',
  'Period,Sep 2026',
  'Date,Details,Credit,Debit,Ref',
  '01/09/2026,Salary,"50,000.00",,',
  '02/09/2026,Rent,,"12,000.00",CHQ-101',
  '02/09/2026,Subscription,,9.99,',
  '03/09/2026,Bad row,,abc,',
  'Closing balance,,,,',
].join('\n')

export const BOOKS = ['date,memo,amount,ref', '2026-08-31,Salary in,50000,', '2026-09-02,Rent cheque,-12000,CHQ-101', '2026-09-03,Sub,-9.99,', '2026-09-03,Sub dup,-9.99,', '2026-09-20,Unpaid,-75,'].join('\n')

// The dropdown closes when the page scrolls, and the scroll event from Playwright's
// scroll-into-view arrives a frame after its click; scroll first and let that event pass.
export async function choose(page: Page, label: string, option: string) {
  const trigger = page.getByRole('combobox', { name: label, exact: true })
  await trigger.scrollIntoViewIfNeeded()
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await trigger.click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

export async function loadAndMap(page: Page, booksFile: string | Buffer = BOOKS) {
  await page.goto('/')
  await page.getByRole('button', { name: /Reconcile/ }).click()
  await expect(page.getByRole('heading', { name: 'Reconcile a bank statement' })).toBeVisible()
  await expect(page.locator('.experimental-note')).toContainText('You confirm every match')
  const bank = page.locator('section.file-panel', { hasText: 'Bank statement' })
  await bank.getByLabel('Choose bank statement').setInputFiles({ name: 'bank.csv', mimeType: 'text/csv', buffer: Buffer.from(BANK) })
  await expect(bank.getByText(/Expected 5 fields|problem/).first()).toBeVisible()
  await bank.getByLabel('Header is record').fill('3')
  await bank.getByLabel('Skip records at the end').fill('1')
  await expect(bank.locator('.file-stats')).toContainText('4 records')
  await expect(bank.getByText(/Skipped 2 records above the header and 1 record at the end/)).toBeVisible()
  const books = page.locator('section.file-panel', { hasText: 'Your ledger' })
  await books.getByLabel('Choose books').setInputFiles({ name: 'books.csv', mimeType: 'text/csv', buffer: typeof booksFile === 'string' ? Buffer.from(booksFile) : booksFile })
  await expect(books.locator('.file-stats')).toBeVisible({ timeout: 60_000 })
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


// Both files with date, amount, ref and memo columns, references shared, a 40-day window,
// and the period and balances entered.
export async function setUpMonth(page: Page, files: { bank: string; books: string }, period: [string, string], balances: [string, string, string, string]) {
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

// Gives every unmatched row its usual classification.
export async function classifyAll(page: Page) {
  await page.getByRole('tab', { name: /^Unmatched/ }).click()
  await expect(page.locator('.review-row').first()).toBeVisible()
  for (const row of await page.locator('.review-row').all()) {
    await row.focus()
    await page.keyboard.press('o')
    await expect(row.locator('.chip')).toBeVisible()
  }
}

// Date fields take their order from the browser, not the page: Chrome on macOS follows the
// system region, Firefox and WebKit their own language. Find the order on a scratch field,
// then type the date the way a person using this browser would. Safari needs the separators.
export async function typeDate(page: Page, label: string, iso: string) {
  const dayFirst = await page.evaluate(async () => {
    const probe = document.createElement('input')
    probe.type = 'date'
    document.body.append(probe)
    probe.focus()
    return probe
  }).then(async () => {
    await page.keyboard.type('01/02/2026')
    return page.evaluate(() => {
      const probe = document.querySelector<HTMLInputElement>('body > input[type="date"]:last-child') as HTMLInputElement
      const value = probe.value
      probe.remove()
      return value === '2026-02-01'
    })
  })
  const [year, month, day] = iso.split('-')
  await page.getByLabel(label).focus()
  await page.keyboard.type(dayFirst ? `${day}/${month}/${year}` : `${month}/${day}/${year}`)
  await expect(page.getByLabel(label)).toHaveValue(iso)
}
