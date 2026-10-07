import { expect, type Page, test } from '@playwright/test'
import { BANK, BOOKS, loadAndMap } from './reconcile-helpers'

async function findSuggestions(page: Page) {
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await expect(page.getByRole('heading', { name: 'Review pairs' })).toBeVisible({ timeout: 60_000 })
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
  await other.goto('/')
  await other.getByRole('button', { name: /Reconcile/ }).click()
  await other.getByRole('button', { name: 'Resume it' }).click()
  await expect(other.getByText(`Loaded a session at revision ${saved} with 1 decision.`)).toBeVisible()

  // The first tab moves on; the second tab's copy is now stale and must not overwrite it.
  await suggestion(page, 'Rent').getByRole('button', { name: 'Reject' }).click()
  await expect(page.locator('.save-status')).toContainText(`Revision ${saved + 1} · 2 decisions · Saved in this browser`)
  await loadFilesAgain(other)
  await findSuggestions(other)
  await suggestion(other, 'Rent').getByRole('button', { name: 'Confirm' }).click()
  await expect(other.locator('.save-status')).toContainText(`Not saved: Another tab saved this session at revision ${saved + 1}. Reload it before saving here. (last saved revision ${saved})`)

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
  await page.getByRole('combobox', { name: 'Books CSV delimiter' }).click()
  await page.getByRole('option', { name: 'Comma', exact: true }).click()
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
