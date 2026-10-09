import { expect, test } from '@playwright/test'
import path from 'node:path'

// Workbooks written by Python XlsxWriter with hand-edited XML (fixtures/xlsxwriter/generate.py):
// SheetJS-written files mark these cells differently, so only independently written files
// exercise the formula-result rule.
const fixture = (name: string) => path.join(import.meta.dirname, '..', 'fixtures', 'xlsxwriter', name)

const NOT_SAVED = /has a formula \(=.+\) with no saved result/

test('a formula with no saved result blocks the file instead of reading as empty', async ({ page }) => {
  await page.goto('./')
  await page.getByLabel('Choose old file').setInputFiles(fixture('multi.xlsx'))
  await page.getByLabel('Choose new file').setInputFiles(fixture('multi.csv'))
  const oldCard = page.locator('section', { has: page.getByLabel('Choose old file') })
  await expect(oldCard.getByText(NOT_SAVED)).toBeVisible()
  await expect(oldCard.getByText(/Data record 1/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Choose matching columns' })).toBeDisabled()
})

test('a row holding only an unsaved formula is reported, not skipped as blank', async ({ page }) => {
  await page.goto('./')
  await page.getByLabel('Choose old file').setInputFiles(fixture('missing-only-row.xlsx'))
  const card = page.locator('section', { has: page.getByLabel('Choose old file') })
  await expect(card.getByText(NOT_SAVED)).toBeVisible()
  await expect(card.getByText(/records? ·/)).toHaveCount(0)
})

test('an unsaved header formula is named as such, not as an empty header', async ({ page }) => {
  await page.goto('./')
  await page.getByLabel('Choose old file').setInputFiles(fixture('missing-header.xlsx'))
  const card = page.locator('section', { has: page.getByLabel('Choose old file') })
  await expect(card.getByText(/Header column \d+ has a formula \(=.+\) with no saved result/)).toBeVisible()
  await expect(card.getByText(/empty header/)).toHaveCount(0)
})

test('saved zero, FALSE and empty-string results still read as values', async ({ page }) => {
  await page.goto('./')
  await page.getByLabel('Choose old file').setInputFiles(fixture('formatted-str.xlsx'))
  await page.getByLabel('Choose new file').setInputFiles(fixture('formatted.csv'))
  await page.getByRole('button', { name: 'Choose matching columns' }).click()
  await page.getByRole('checkbox', { name: 'id', exact: true }).check()
  await page.getByRole('button', { name: 'Compare files', exact: true }).click()
  await expect(page.locator('.metric.unchanged strong')).toHaveText('2')
  await expect(page.locator('.metric.changed strong')).toHaveText('0')
})
