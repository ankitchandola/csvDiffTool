import { expect, test, type Page } from '@playwright/test'

const oldCSV = 'id,name,price\n001,Old,10\n002,Same,20\n003,Removed,30\n'
const newCSV = 'id,name,price\n001,New,10\n002,Same,20\n004,Added,40\n'

async function loadFiles(page: Page, old = oldCSV, updated = newCSV) {
  await page.getByLabel('Choose old file').setInputFiles({
    name: 'baseline.csv', mimeType: 'text/csv', buffer: Buffer.from(old),
  })
  await page.getByLabel('Choose new file').setInputFiles({
    name: 'updated.csv', mimeType: 'text/csv', buffer: Buffer.from(updated),
  })
  await expect(page.getByRole('button', { name: 'Choose matching columns' })).toBeEnabled()
}

async function matchFiles(page: Page) {
  await loadFiles(page)
  await page.getByRole('button', { name: 'Choose matching columns' }).click()
  await expect(page.getByRole('heading', { name: 'Match records' })).toBeFocused()
  await page.getByRole('checkbox', { name: 'id', exact: true }).check()
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

test('steps replace each other, preserve setup, and invalidate stale results', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('./')
  const iconURL = await page.locator('link[rel="icon"]').getAttribute('href')
  await expect(page.locator('.brand-icon')).toHaveAttribute('src', iconURL!)
  const artwork = await (await page.request.get(iconURL!)).text()
  expect(artwork).toContain('viewBox="0 0 48 46"')
  expect(artwork).toContain('#863bff')
  expect(await page.locator('.brand-icon').evaluate((image: HTMLImageElement) =>
    image.complete && image.naturalWidth > 0,
  )).toBe(true)
  expect(await page.locator('html').evaluate((element) =>
    getComputedStyle(element).getPropertyValue('--accent').trim(),
  )).toBe('#863bff')
  await expect(page.locator('select')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Choose matching columns' })).toBeDisabled()
  await matchFiles(page)
  await expect(page.locator('#files')).toHaveCount(0)
  await page.getByRole('button', { name: 'Back to files' }).click()
  await expect(page.locator('#rules')).toHaveCount(0)
  await expect(page.getByText('baseline.csv', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Choose matching columns' }).click()
  await expect(page.getByRole('checkbox', { name: 'id', exact: true })).toBeChecked()
  await page.getByRole('button', { name: 'Compare files', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Comparison results' })).toBeFocused()
  await expect(page.locator('#rules, #files')).toHaveCount(0)
  await expect(page.locator('.metric strong')).toHaveText(['1', '1', '1', '1'])
  await expect(page.locator('.vlist .before')).toHaveText('before: Old')
  await expect(page.locator('.vlist .after')).toHaveText('after: New')
  await page.getByRole('combobox', { name: 'Changed column' }).click()
  await page.getByRole('option', { name: 'name (1)', exact: true }).click()
  await expect(page.locator('.change.focus')).toHaveCount(1)
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Full JSON', exact: true }).click()
  const stream = await (await downloadEvent).createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  const json = JSON.parse(Buffer.concat(chunks).toString())
  expect(json).toHaveProperty('summary')
  await page.getByRole('button', { name: 'Edit comparison' }).click()
  await page.getByText('Key options', { exact: false }).click()
  await page.getByLabel('Match keys case-insensitively').check()
  await expect(page.getByRole('button', { name: '3 Results' })).toBeDisabled()
  await expect(page.getByText('Setup changed. Compare again to update results.')).toBeVisible()
  await page.getByRole('button', { name: 'Compare files', exact: true }).click()
  await expect(page.locator('#results')).toBeVisible()
  await noHorizontalOverflow(page)
  expect(errors).toEqual([])
})

test('dropdown supports keyboard, typeahead, escape, tab, and outside click', async ({ page }) => {
  await page.goto('./')
  const combo = page.getByRole('combobox', { name: 'Delimiter' })
  await combo.focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('listbox')).toBeVisible()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(combo).toHaveText('Tab')
  await combo.press('Space')
  await combo.press('Home')
  await combo.press('Enter')
  await expect(combo).toHaveText('Detect automatically')
  await combo.press('s')
  await combo.press('Enter')
  await expect(combo).toHaveText('Semicolon')
  await combo.click()
  await combo.press('ArrowDown')
  await combo.press('Escape')
  await expect(combo).toHaveText('Semicolon')
  await expect(combo).toBeFocused()
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await combo.click()
  await combo.press('Tab')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await combo.click()
  await page.getByRole('heading', { name: 'Compare CSV files' }).click()
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await combo.click()
  await page.getByRole('option', { name: 'Comma', exact: true }).click()
  await expect(combo).toHaveText('Comma')
})

test('saved profiles use custom dropdown and survive reload', async ({ page }) => {
  await page.goto('./')
  await matchFiles(page)
  await page.locator('.profile-disclosure > summary').click()
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Daily export')
  await page.getByRole('button', { name: 'Save profile', exact: true }).click()
  await expect(page.getByRole('status')).toContainText(['Saved “Daily export”.'])
  await page.reload()
  await page.locator('.profile-disclosure > summary').click()
  await page.getByRole('combobox', { name: 'Saved profiles' }).click()
  await page.getByRole('option', { name: 'Daily export' }).click()
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await loadFiles(page)
  await page.getByRole('button', { name: 'Choose matching columns' }).click()
  await expect(page.getByRole('checkbox', { name: 'id', exact: true })).toBeChecked()
})

test('file replacement keeps the missing-key recovery reachable', async ({ page }) => {
  await page.goto('./')
  await matchFiles(page)
  await page.getByRole('button', { name: 'Back to files' }).click()
  await loadFiles(page, 'sku,name\n1,Old\n', 'sku,name\n1,New\n')
  await page.getByRole('button', { name: 'Choose matching columns' }).click()
  await expect(page.getByText(/Key column id missing/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Compare files', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Remove from key' }).click()
  await page.getByRole('checkbox', { name: 'sku', exact: true }).check()
  await page.getByRole('button', { name: 'Compare files', exact: true }).click()
  await expect(page.locator('#results')).toBeVisible()
})

for (const width of [1440, 768, 390]) {
  test(`workspace stays readable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('./')
    await noHorizontalOverflow(page)
    if (width === 1440) {
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(900)
    }
    await page.screenshot({ path: testInfo.outputPath('files.png'), fullPage: true })
    await matchFiles(page)
    await noHorizontalOverflow(page)
    await page.screenshot({ path: testInfo.outputPath('match.png'), fullPage: true })
    await page.getByRole('button', { name: 'Compare files', exact: true }).click()
    await expect(page.locator('.vlist .after')).toHaveText('after: New')
    await noHorizontalOverflow(page)
    if (width === 1440) {
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(900)
    }
    await page.screenshot({ path: testInfo.outputPath('results.png'), fullPage: true })
    await page.getByRole('combobox', { name: 'Changed column' }).click()
    const menu = await page.getByRole('listbox').boundingBox()
    expect(menu).not.toBeNull()
    expect(menu!.x).toBeGreaterThanOrEqual(0)
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(width)
    await page.keyboard.press('Escape')
    await page.getByRole('tab', { name: /Changed/ }).focus()
    await page.keyboard.press('Home')
    await expect(page.getByRole('tab', { name: /Added/ })).toBeFocused()
    await page.keyboard.press('End')
    await expect(page.getByRole('tab', { name: /Problems/ })).toBeFocused()
  })
}

test('dropdown selection works with touch', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await page.goto('./')
  const combo = page.getByRole('combobox', { name: 'Delimiter' })
  await combo.tap()
  await page.getByRole('option', { name: 'Semicolon' }).tap()
  await expect(combo).toHaveText('Semicolon')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await context.close()
})

test('advanced rules, exclusions and both exports remain available', async ({ page }) => {
  await page.goto('./')
  await loadFiles(
    page,
    'id,price,name\n1,1.00,OLD\n2,N/A,Same\n3,3,Dup\n3,3,Dup\n,4,Empty\n',
    'id,price,name\n1,1.01,old\n2,N/A,Same\n3,3,Dup\n,4,Empty\n',
  )
  await page.getByRole('button', { name: 'Choose matching columns' }).click()
  await page.getByRole('checkbox', { name: 'id', exact: true }).check()
  await expect(page.locator('.key-problems > summary')).toContainText('1 ambiguous key ·')
  await page.locator('.key-problems > summary').click()
  await expect(page.locator('.key-problems')).toContainText('3')
  await page.locator('.value-disclosure > summary').click()
  await page.getByLabel('Compare price numerically').check()
  await page.getByLabel('Tolerance for price').fill('0.01')
  await page.getByLabel('Ignore case for name').check()
  await page.getByRole('button', { name: 'Back to files' }).click()
  await page.getByRole('button', { name: 'Choose matching columns' }).click()
  await page.locator('.value-disclosure > summary').click()
  await expect(page.getByLabel('Tolerance for price')).toHaveValue('0.01')
  await page.getByRole('button', { name: 'Compare files', exact: true }).click()
  await expect(page.locator('.metric strong')).toHaveText(['0', '0', '0', '2'])
  await expect(page.locator('.result-warning')).toContainText('1 ambiguous key and 2 empty-key records')
  await expect(page.locator('.result-warning')).toContainText('2 numeric warnings')
  await page.getByRole('tab', { name: /Problems/ }).click()
  await page.getByRole('button', { name: /Numeric warnings/ }).click()
  await expect(page.locator('.vlist-row')).toHaveCount(2)
  await page.locator('.export-details > summary').click()
  await expect(page.getByLabel('Protect the CSV against spreadsheet formulas')).toBeChecked()
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Changes CSV', exact: true }).click()
  expect((await downloadEvent).suggestedFilename()).toBe('csv-diff-changes.csv')
})

test('long names, scrolling dropdown options and chevrons fit mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('./')
  const header = 'long_column_name_'.repeat(12)
  await loadFiles(page, `id,${header}\n1,before\n`, `id,${header}\n1,after\n`)
  await page.getByRole('button', { name: 'Choose matching columns' }).click()
  await noHorizontalOverflow(page)
  await page.getByRole('checkbox', { name: 'id', exact: true }).check()
  await page.getByRole('button', { name: 'Compare files', exact: true }).click()
  await page.getByRole('combobox', { name: 'Changed column' }).click()
  await page.getByRole('option', { name: `${header} (1)`, exact: true }).click()
  await noHorizontalOverflow(page)
  await expect(page.locator('.change.focus')).toHaveCount(1)
  for (const summary of await page.locator('summary').all()) {
    expect(await summary.evaluate((element) => getComputedStyle(element, '::after').borderRightStyle)).toBe('solid')
  }
  await page.getByRole('button', { name: 'Edit comparison' }).click()
  await page.locator('.profile-disclosure > summary').click()
  for (let index = 0; index < 10; index++) {
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`Profile ${index}`)
    await page.getByRole('button', { name: 'Save profile', exact: true }).click()
  }
  const profiles = page.getByRole('combobox', { name: 'Saved profiles' })
  await profiles.click()
  await profiles.press('End')
  await expect(page.getByRole('option', { name: 'Profile 9' })).toBeInViewport()
  await profiles.press('Enter')
  await expect(profiles).toHaveText('Profile 9')
  await noHorizontalOverflow(page)
})

test('delimiter changes reparse files without skipping the files step', async ({ page }) => {
  await page.goto('./')
  await loadFiles(page, 'id;name\n1;Old\n', 'id;name\n1;New\n')
  await page.getByRole('combobox', { name: 'Delimiter' }).click()
  await page.getByRole('option', { name: 'Semicolon' }).click()
  await expect(page.getByRole('button', { name: 'Choose matching columns' })).toBeEnabled()
  await expect(page.locator('#files')).toBeVisible()
  await page.getByRole('button', { name: 'Choose matching columns' }).click()
  await page.getByRole('checkbox', { name: 'id', exact: true }).check()
  await page.getByRole('button', { name: 'Compare files', exact: true }).click()
  await expect(page.locator('.metric.changed strong')).toHaveText('1')
})
