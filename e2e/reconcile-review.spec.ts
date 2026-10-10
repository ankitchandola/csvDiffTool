import { type Page } from '@playwright/test'
import { expect, test } from './reconcile-test'
import { BANK, BOOKS, choose, loadAndMap } from './reconcile-helpers'

async function findSuggestions(page: Page) {
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await expect(page.getByRole('heading', { name: 'Review matches' })).toBeVisible({ timeout: 60_000 })
}

function tabCount(page: Page, name: string) {
  return page.getByRole('tab', { name: new RegExp(`^${name}`) }).locator('.tab-count')
}

function suggestion(page: Page, text: string) {
  return page.locator('.review-row', { hasText: text }).first()
}

async function readDownload(page: Page, click: () => Promise<void>): Promise<string> {
  const event = page.waitForEvent('download')
  await click()
  const stream = await (await event).createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString()
}

async function loadFilesAgain(page: Page) {
  const bank = page.locator('section.file-panel', { hasText: 'Bank statement' })
  await bank.getByLabel('Choose bank statement').setInputFiles({ name: 'bank.csv', mimeType: 'text/csv', buffer: Buffer.from(BANK) })
  await expect(bank.locator('.file-stats')).toContainText('4 records')
  await page.getByLabel('Choose books').setInputFiles({ name: 'books.csv', mimeType: 'text/csv', buffer: Buffer.from(BOOKS) })
  await page.getByRole('button', { name: 'Map dates and amounts' }).click()
}

test('confirm, unmatch, reject and restore with buttons and keys', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await loadAndMap(page)
  await findSuggestions(page)
  await expect(tabCount(page, 'Suggested')).toHaveText('4')

  await suggestion(page, 'Salary in').getByRole('button', { name: 'Confirm' }).click()
  await expect(tabCount(page, 'Confirmed')).toHaveText('1')
  await expect(tabCount(page, 'Suggested')).toHaveText('3')
  await page.getByRole('tab', { name: /^Confirmed/ }).click()
  await page.getByLabel('Search this tab').fill('Salary')
  await expect(page.getByRole('status').filter({ hasText: '1 match shown for these filters.' })).toBeVisible()
  await page.getByLabel('Search this tab').fill('')
  await page.getByRole('tab', { name: /^Suggested/ }).click()

  // Keyboard: J moves to the first row, X rejects it.
  await page.locator('.review-row').first().focus()
  await expect(page.locator('.review-row').first()).toContainText('Rent')
  await page.keyboard.press('j')
  await expect(page.locator('.review-row').nth(1)).toBeFocused()
  await page.keyboard.press('k')
  await page.keyboard.press('x')
  await expect(tabCount(page, 'Rejected')).toHaveText('1')
  await expect(tabCount(page, 'Suggested')).toHaveText('2')

  // C confirms the focused row; competing pairs that share a transaction disappear.
  await page.locator('.review-row').first().focus()
  await page.keyboard.press('c')
  await expect(tabCount(page, 'Confirmed')).toHaveText('2')
  await expect(tabCount(page, 'Suggested')).toHaveText('0')

  // Typing in the search box never triggers a shortcut.
  await page.getByLabel('Search this tab').fill('xc')
  await expect(tabCount(page, 'Confirmed')).toHaveText('2')
  await page.getByLabel('Search this tab').fill('')

  await page.getByRole('tab', { name: /^Confirmed/ }).click()
  await page.getByLabel('Search this tab').fill('s')
  await expect(page.getByRole('status').filter({ hasText: '2 matches shown for these filters.' })).toBeVisible()
  await page.getByLabel('Search this tab').fill('')
  await page.locator('.review-row', { hasText: 'Salary in' }).getByRole('button', { name: 'Unmatch' }).click()
  await expect(tabCount(page, 'Confirmed')).toHaveText('1')

  await page.getByRole('tab', { name: /^Rejected/ }).click()
  await page.getByRole('button', { name: 'Restore suggestion' }).click()
  await expect(tabCount(page, 'Rejected')).toHaveText('0')
  await expect(page.locator('.history summary')).toHaveText('Decision history (5)')
  expect(errors).toEqual([])
})

test('a manual pair that breaks the rules needs a reason, and opposite directions are blocked', async ({ page }) => {
  await loadAndMap(page)
  await findSuggestions(page)
  await page.getByRole('tab', { name: /^Unmatched/ }).click()
  // The list is virtualized and starts below the fold; bring it into view so every row renders.
  await page.getByRole('region', { name: 'Unmatched transactions' }).scrollIntoViewIfNeeded()
  const select = (text: string) => page.locator('.review-row', { hasText: text }).getByRole('button', { name: 'Select for pair' }).click()
  await select('Bank record 1 ')
  await select('Unpaid')
  await expect(page.locator('.manual-pair [role="alert"]')).toHaveText('Money in cannot pair with money out')
  await page.getByRole('button', { name: 'Clear selection' }).click()
  await select('Bank record 2 ')
  await select('Unpaid')
  await expect(page.locator('.manual-pair')).toContainText('This pair breaks the rules: amounts differ, dates are outside the window')
  const confirm = page.getByRole('button', { name: 'Confirm manual pair' })
  await expect(confirm).toBeDisabled()
  await page.getByLabel('Reason').fill('Part payment of rent')
  await confirm.click()
  await expect(tabCount(page, 'Confirmed')).toHaveText('1')
  await page.getByRole('tab', { name: /^Confirmed/ }).click()
  await expect(page.locator('.review-row')).toContainText('Manual pair: amounts differ, dates are outside the window — “Part payment of rent”')
})

test('a session backup restores decisions after a reload, and a different file lapses them', async ({ page }) => {
  await loadAndMap(page)
  await findSuggestions(page)
  await suggestion(page, 'Salary in').getByRole('button', { name: 'Confirm' }).click()
  await expect(page.locator('.save-status')).toContainText(/Revision \d+ · 1 decision · Not saved in this browser · No backup/)
  const revision = Number((await page.locator('.save-status').textContent())?.match(/Revision (\d+)/)?.[1])
  await expect(page.locator('.session-bar .warning')).toBeVisible()
  const text = await readDownload(page, () => page.getByRole('button', { name: 'Export session backup' }).click())
  await expect(page.locator('.save-status')).toContainText(`Backup at revision ${revision}`)
  await expect(page.locator('.session-bar .warning')).toHaveCount(0)
  const backup = JSON.parse(text)
  expect(backup).toMatchObject({ format: 'reconciliation-session', version: 1, revision, events: [{ seq: 1, action: 'confirm', origin: 'suggested' }] })
  expect(backup.snapshots.map((s: { amount: string }) => s.amount)).toEqual(['50000.00', '50000.00'])

  await page.reload()
  await page.getByRole('button', { name: /Reconcile/ }).click()
  await page.getByLabel('Import session file').setInputFiles({ name: 'session.json', mimeType: 'application/json', buffer: Buffer.from(text) })
  await expect(page.getByText(`Loaded a session at revision ${revision} with 1 decision.`)).toBeVisible()
  await expect(page.getByText('Bank: bank.csv — not loaded yet')).toBeVisible()
  const bank = page.locator('section.file-panel', { hasText: 'Bank statement' })
  await expect(bank.getByLabel('Header is record')).toHaveValue('3')
  await loadFilesAgain(page)
  await expect(page.getByLabel('Currency')).toHaveValue('INR')
  await findSuggestions(page)
  await expect(tabCount(page, 'Confirmed')).toHaveText('1')
  await expect(page.locator('.lapsed')).toHaveCount(0)
  await expect(page.getByText('Load the same files, then find suggestions to apply them.', { exact: false })).toHaveCount(0)

  // Replace the books file: its decisions no longer apply but stay in the history.
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await page.getByLabel('Choose books').setInputFiles({ name: 'books.csv', mimeType: 'text/csv', buffer: Buffer.from(BOOKS + '\n2026-09-30,Extra,1,') })
  await page.getByRole('button', { name: 'Map dates and amounts' }).click()
  await findSuggestions(page)
  await expect(tabCount(page, 'Confirmed')).toHaveText('0')
  await expect(page.locator('.lapsed summary')).toHaveText('1 earlier decision no longer applies')
})

test('saving in this browser survives a reload and refuses a stale tab', async ({ page, context }) => {
  await loadAndMap(page)
  await findSuggestions(page)
  await page.getByLabel('Save this session in this browser').check()
  await expect(page.locator('.save-status')).toContainText('Saved in this browser')
  await suggestion(page, 'Salary in').getByRole('button', { name: 'Confirm' }).click()
  await expect(page.locator('.save-status')).toContainText(/Revision \d+ · 1 decision · Saved in this browser · No backup/)
  const saved = Number((await page.locator('.save-status').textContent())?.match(/Revision (\d+)/)?.[1])

  const other = await context.newPage()
  await other.goto('./')
  await other.getByRole('button', { name: /Reconcile/ }).click()
  await other.getByRole('button', { name: 'Resume it' }).click()
  await expect(other.getByText(`Loaded a session at revision ${saved} with 1 decision.`)).toBeVisible()

  // The first tab moves on; the second tab's copy is now stale and must not overwrite it.
  await suggestion(page, 'Rent').getByRole('button', { name: 'Reject' }).click()
  await expect(page.locator('.save-status')).toContainText(`Revision ${saved + 1} · 2 decisions · Saved in this browser`)
  await loadFilesAgain(other)
  await findSuggestions(other)
  await suggestion(other, 'Rent').getByRole('button', { name: 'Confirm' }).click()
  await expect(other.locator('.save-status')).toContainText(`Not saved: A newer revision is saved in this browser (revision ${saved + 1}). Resume the saved session before saving here. (last saved revision ${saved})`)
  await other.getByRole('button', { name: 'Resume the saved session' }).click()
  await expect(other.getByText(`Loaded a session at revision ${saved + 1} with 2 decisions.`)).toBeVisible()
  await expect(other.getByRole('button', { name: 'Resume the saved session' })).toHaveCount(0)

  await page.reload()
  await page.getByRole('button', { name: /Reconcile/ }).click()
  await page.getByRole('button', { name: 'Resume it' }).click()
  await expect(page.getByText(`Loaded a session at revision ${saved + 1} with 2 decisions.`)).toBeVisible()
  await page.getByRole('button', { name: 'Delete the session saved in this browser' }).click()
  await expect(page.getByRole('button', { name: 'Delete the session saved in this browser' })).toHaveCount(0)
})

test('cancelling the worker keeps decisions, which apply again after the files are read', async ({ page }) => {
  test.setTimeout(120_000)
  // Unmatched filler rows make reading slow enough to cancel.
  const books = BOOKS + '\n' + '2026-01-01,Filler,1.23,\n'.repeat(600_000)
  await loadAndMap(page, books)
  await findSuggestions(page)
  await suggestion(page, 'Salary in').getByRole('button', { name: 'Confirm' }).click()
  await expect(tabCount(page, 'Confirmed')).toHaveText('1')
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const booksPanel = page.locator('section.file-panel', { hasText: 'Your ledger' })
  await choose(page, 'Books CSV delimiter', 'Comma')
  await expect(page.locator('.activity-row', { hasText: 'Reading books' })).toBeVisible()
  await page.locator('.activity').getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.locator('.save-status')).toContainText('1 decision')
  await page.getByRole('button', { name: 'Read bank.csv again' }).click()
  await booksPanel.getByRole('button', { name: 'Read books.csv again' }).click()
  await expect(booksPanel.locator('.file-stats')).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Map dates and amounts' }).click()
  await findSuggestions(page)
  await expect(tabCount(page, 'Confirmed')).toHaveText('1')
})

const SET_BANK = ['Date,Details,Credit,Debit,Ref', '05/09/2026,NETFLIX,,9.99,', '05/09/2026,NETFLIX,,9.99,', '05/09/2026,NETFLIX,,9.99,', '06/09/2026,Rent,,50.00,'].join('\n')
const SET_BOOKS = ['date,memo,amount,ref', '2026-09-05,Netflix,-9.99,', '2026-09-05,Netflix,-9.99,', '2026-09-06,Rent,-50,', '2026-09-06,Other rent,-50,'].join('\n')

async function mapSetFiles(page: Page) {
  await page.goto('./')
  await page.getByRole('button', { name: /Reconcile/ }).click()
  await page.getByLabel('Choose bank statement').setInputFiles({ name: 'bank.csv', mimeType: 'text/csv', buffer: Buffer.from(SET_BANK) })
  await page.getByLabel('Choose books').setInputFiles({ name: 'books.csv', mimeType: 'text/csv', buffer: Buffer.from(SET_BOOKS) })
  await page.getByRole('button', { name: 'Map dates and amounts' }).click()
  await page.getByLabel('Currency').fill('INR')
  await choose(page, 'Bank statement date column', 'Date')
  await choose(page, 'Bank statement date format', 'DD/MM/YYYY')
  await page.getByRole('radiogroup', { name: 'Bank statement amount layout' }).getByLabel(/Separate/).check()
  await choose(page, 'Bank statement money-in column', 'Credit')
  await choose(page, 'Bank statement money-out column', 'Debit')
  await choose(page, 'Bank statement description column', 'Details')
  await choose(page, 'Books date column', 'date')
  await choose(page, 'Books date format', 'YYYY-MM-DD')
  await choose(page, 'Books amount column', 'amount')
  await choose(page, 'Books description column', 'memo')
  await findSuggestions(page)
}

test('an identical set is confirmed in one step, with the reviewer choosing which extra row stays unmatched', async ({ page }) => {
  await mapSetFiles(page)
  await expect(page.getByText('Identical amounts and dates, different descriptions: review pair by pair.').first()).toBeVisible()
  await page.locator('.review-row', { hasText: 'Identical set' }).first().getByRole('button', { name: 'Confirm set…' }).click()
  const panel = page.getByRole('region', { name: /Confirm set/ })
  await expect(panel).toContainText('3 bank transactions · 2 books transactions still open')
  await expect(panel.getByRole('checkbox', { checked: true })).toHaveCount(2)
  await expect(panel.locator('.set-pairs li')).toHaveText(['Bank record 1 · line 2 ↔ Books record 1 · line 2', 'Bank record 2 · line 3 ↔ Books record 2 · line 3'])
  // Keep record 3 instead of record 2.
  await panel.getByRole('checkbox', { name: 'Bank record 2 · line 3' }).uncheck()
  await panel.getByRole('checkbox', { name: 'Bank record 3 · line 4' }).check()
  await expect(panel.locator('.set-pairs li').nth(1)).toHaveText('Bank record 3 · line 4 ↔ Books record 2 · line 3')
  await panel.getByRole('button', { name: 'Confirm 2 pairs' }).click()
  await expect(tabCount(page, 'Confirmed')).toHaveText('2')
  await expect(page.locator('.save-status')).toContainText('2 decisions')
  await page.getByRole('tab', { name: /^Confirmed/ }).click()
  await expect(page.locator('.review-row').first()).toContainText('Confirmed as part of an identical set; the pairing within the set is arbitrary')
  await page.getByRole('tab', { name: /^Unmatched/ }).click()
  await expect(page.locator('.review-row', { hasText: 'Bank record 2 · line 3' })).toBeVisible()
})

test('details show the whole source row, open alternatives and variance, and open with Enter', async ({ page, context, browserName }) => {
  // Only Chromium lets a test grant clipboard access and read the clipboard back.
  const readable = browserName === 'chromium'
  if (readable) await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await loadAndMap(page)
  await findSuggestions(page)
  const row = page.locator('.review-row', { hasText: 'Subscription' }).first()
  await row.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Transaction details' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Amount difference (bank − books): none. Dates: bank date 1 day before books.')
  await expect(dialog.locator('.inspect-detail').first()).toContainText('Open suggestions (2)')
  await expect(dialog.locator('.inspect-detail').first().locator('th')).toHaveText(['Date', 'Details', 'Credit', 'Debit', 'Ref'])
  await dialog.getByRole('button', { name: 'Copy source row' }).first().click()
  await expect(dialog.getByRole('status')).toHaveText('Copied as tab-separated text.')
  if (readable) expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Date\tDetails\tCredit\tDebit\tRef\n02/09/2026\tSubscription\t\t9.99\t')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(row).toBeFocused()
})

test('completion needs validated balances, every unmatched item classified, and the reviewer’s mark', async ({ page }) => {
  await mapSetFiles(page)
  await page.getByRole('button', { name: 'Edit mapping' }).click()
  await page.getByLabel('Period start').fill('2026-09-01')
  await page.getByLabel('Period end').fill('2026-09-30')
  await page.getByLabel('Bank opening balance').fill('1000.00')
  await page.getByLabel('Bank closing balance').fill('920.03')
  await page.getByLabel('Books opening balance').fill('1000.00')
  await page.getByLabel('Books closing balance').fill('880.02')
  await page.getByRole('button', { name: '3 Review' }).click()
  const panel = page.getByRole('region', { name: 'Reconciliation status' })
  await expect(panel.locator('.status.earned')).toHaveCount(2)
  await expect(panel).toContainText('Outstanding items reviewed: not yet — 8 unmatched items are not classified')
  await expect(panel.getByRole('button', { name: 'Mark reconciliation complete' })).toBeDisabled()

  await page.locator('.review-row', { hasText: 'Identical set' }).first().getByRole('button', { name: 'Confirm set…' }).click()
  await page.getByRole('region', { name: /Confirm set/ }).getByRole('button', { name: 'Confirm 2 pairs' }).click()
  await page.locator('.review-row', { hasText: 'Rent' }).filter({ hasNotText: 'Other rent' }).first().getByRole('button', { name: 'Confirm' }).click()
  await expect(panel).toContainText('2 unmatched items are not classified')

  await page.getByRole('tab', { name: /^Unmatched/ }).click()
  await page.locator('.review-row', { hasText: 'NETFLIX' }).focus()
  await page.keyboard.press('o')
  await expect(page.locator('.review-row', { hasText: 'NETFLIX' }).locator('.chip')).toHaveText('Record in books')
  await choose(page, 'Classification for Books record 4 · line 5', 'Outstanding payment (not yet cleared by the bank)')
  await expect(panel.locator('.status.earned')).toHaveCount(3)

  await panel.getByRole('button', { name: 'Mark reconciliation complete' }).click()
  await expect(panel).toContainText('Reconciliation completed: yes')
  await expect(page.locator('.history summary')).toHaveText('Decision history (6)')

  // A changed balance withdraws the completion.
  await page.getByRole('button', { name: 'Edit mapping' }).click()
  await page.getByLabel('Books closing balance').fill('880.03')
  await page.getByRole('button', { name: '3 Review' }).click()
  await expect(panel).toContainText('Reconciliation completed: not yet')
  await expect(panel).toContainText('Source balances validated: not yet')
})
