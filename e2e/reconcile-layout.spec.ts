import { expect, test } from '@playwright/test'
import path from 'node:path'

// Uses the plain test, not the one from reconcile-test.ts, so optional sections start folded as people see them.
test('statement layout opens for a file that fails to read and stays open while it is corrected', async ({ page }) => {
  await page.goto('./')
  await page.getByRole('button', { name: /Reconcile/ }).click()
  const panel = page.locator('section.file-panel', { hasText: 'Bank statement' })
  const layout = panel.locator('details.layout-details')
  await expect(layout).not.toHaveAttribute('open')
  await panel.getByLabel('Choose bank statement').setInputFiles(path.join(import.meta.dirname, '..', 'fixtures', 'reconcile', 'icici-statement-2026-09.csv'))
  await expect(panel.getByText(/problems found/)).toBeVisible()
  await expect(layout).toHaveAttribute('open')
  await panel.getByLabel('Header is record').fill('4')
  await panel.getByLabel('Skip records at the end').fill('2')
  await expect(panel.locator('.file-stats')).toContainText('13 records')
  await expect(layout).toHaveAttribute('open')
  await layout.locator('summary').click()
  await expect(layout).not.toHaveAttribute('open')
})
