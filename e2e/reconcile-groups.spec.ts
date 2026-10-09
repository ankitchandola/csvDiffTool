import { expect, test } from '@playwright/test'
import { BANK, choose, loadAndMap } from './reconcile-helpers'

// The salary receipt arrives in two books rows of one payout; another payout nets a refund.
const BOOKS = [
  'date,memo,amount,ref,payout',
  '2026-08-31,Salary part 1,30000,,PO-1',
  '2026-09-02,Rent cheque,-12000,CHQ-101,',
  '2026-09-03,Sub,-9.99,,',
  '2026-08-31,Salary part 2,20000,,PO-1',
  '2026-09-05,Order,10,,PO-2',
  '2026-09-06,Refund,-5,,PO-2',
].join('\n')

test('rows sharing a payout ID are suggested as one total, shown member by member, and a netted payout is a problem', async ({ page }) => {
  await loadAndMap(page, BOOKS)
  await choose(page, 'Books batch ID column', 'payout')
  await page.getByRole('button', { name: 'Check mapping' }).click()
  const check = page.getByRole('region', { name: 'Mapping check' })
  await expect(check.getByText('6 records: 4 valid (2 money in, 2 money out) · 0 zero · 2 records with problems · 1 batch matched as totals')).toBeVisible()

  await page.getByRole('button', { name: 'Find suggestions' }).click()
  const payout = page.locator('.review-row', { hasText: 'Batch PO-1: 2 records' })
  await expect(payout).toContainText('50000.00')
  await payout.getByText('Batch total of 2 records, dated by the latest').click()
  await expect(payout.locator('.group-members li')).toHaveText([/30000\.00 · Salary part 1 · Books record 1/, /20000\.00 · Salary part 2 · Books record 4/])
  await payout.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(page.getByRole('tab', { name: /^Confirmed/ })).toContainText('1')

  await page.getByRole('tab', { name: /^Problems/ }).click()
  await expect(page.locator('.problem-row', { hasText: 'Batch “PO-2” has money in and money out' })).toHaveCount(2)

  await page.getByLabel('Save this session in this browser').check()
  await expect(page.locator('.save-status')).toContainText('Saved in this browser')
  await page.reload()
  await page.getByRole('button', { name: /Reconcile/ }).click()
  await page.getByRole('button', { name: 'Resume it' }).click()
  await page.getByLabel('Choose bank statement').setInputFiles({ name: 'bank.csv', mimeType: 'text/csv', buffer: Buffer.from(BANK) })
  await expect(page.locator('section.file-panel', { hasText: 'Bank statement' }).locator('.file-stats')).toContainText('4 records')
  await page.getByLabel('Choose books').setInputFiles({ name: 'books.csv', mimeType: 'text/csv', buffer: Buffer.from(BOOKS) })
  await page.getByRole('button', { name: 'Map dates and amounts' }).click()
  await page.getByRole('button', { name: 'Check mapping' }).click()
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await page.getByRole('tab', { name: /^Confirmed/ }).click()
  await expect(page.locator('.review-row', { hasText: 'Batch PO-1: 2 records' })).toBeVisible()
  await page.locator('.review-row', { hasText: 'Batch PO-1' }).getByRole('button', { name: 'Unmatch' }).click()
  await expect(page.getByRole('tab', { name: /^Confirmed/ })).toContainText('0')
  await expect(page.getByRole('tab', { name: /^Suggested/ })).toContainText('3')
})

test('a batch can’t join a group of other transactions', async ({ page }) => {
  await loadAndMap(page, BOOKS)
  await choose(page, 'Books batch ID column', 'payout')
  await page.getByRole('button', { name: 'Check mapping' }).click()
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await page.getByRole('tab', { name: /^Unmatched/ }).click()
  for (const text of ['Batch PO-1', 'Rent cheque']) await page.locator('.review-row', { hasText: text }).getByRole('button', { name: 'Select for pair' }).click()
  await expect(page.getByRole('region', { name: 'Manual pair' }).getByRole('alert')).toHaveText('A batch is matched as a whole; it can’t join a group of other transactions')
})
