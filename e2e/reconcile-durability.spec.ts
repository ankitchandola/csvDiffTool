import { expect, type Page, test } from '@playwright/test'
import { BANK, BOOKS, choose, loadAndMap, setUpMonth, typeDate } from './reconcile-helpers'

// Milestone 3 durability: storage failures, a browser without IndexedDB, a corrupted
// saved session, and two tabs saving at the same moment.


async function findSuggestions(page: Page) {
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await expect(page.getByRole('heading', { name: 'Review pairs' })).toBeVisible({ timeout: 60_000 })
}

function confirmPair(page: Page, text: string) {
  return page.locator('.review-row', { hasText: text }).first().getByRole('button', { name: 'Confirm' }).click()
}

async function loadFiles(page: Page) {
  const bank = page.locator('section.file-panel', { hasText: 'Bank statement' })
  await bank.getByLabel('Choose bank statement').setInputFiles({ name: 'bank.csv', mimeType: 'text/csv', buffer: Buffer.from(BANK) })
  await expect(bank.locator('.file-stats')).toContainText('4 records')
  await page.getByLabel('Choose books').setInputFiles({ name: 'books.csv', mimeType: 'text/csv', buffer: Buffer.from(BOOKS) })
  await page.getByRole('button', { name: 'Map dates and amounts' }).click()
}

test('a full browser storage reports the failure and a backup still protects the decisions', async ({ page }) => {
  await page.addInitScript(() => {
    IDBObjectStore.prototype.put = function () {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    }
  })
  await loadAndMap(page)
  await findSuggestions(page)
  await confirmPair(page, 'Salary in')
  await page.getByLabel('Save this session in this browser').check()
  await expect(page.locator('.save-status')).toContainText("Not saved: This browser's storage for the page is full")
  await expect(page.locator('.session-bar .warning')).toContainText('reloading the page loses them')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export session backup' }).click()
  const chunks: Buffer[] = []
  for await (const chunk of await (await download).createReadStream()) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString()
  expect(JSON.parse(text).events).toMatchObject([{ action: 'confirm' }])
  await expect(page.locator('.save-status')).toContainText(/Backup at revision \d+/)
  await expect(page.locator('.session-bar .warning')).toHaveCount(0)
  await page.reload()
  await page.getByRole('button', { name: /Reconcile/ }).click()
  await page.getByLabel('Import session file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(text) })
  await expect(page.getByText(/Loaded a session/)).toBeVisible()
  await loadFilesAgain(page)
  await findSuggestions(page)
  await expect(page.getByRole('tab', { name: /^Confirmed/ }).locator('.tab-count')).toHaveText('1')
  await page.getByRole('tab', { name: /^Confirmed/ }).click()
  await expect(page.locator('.review-row')).toContainText('Salary in')
})

// Chrome's own quota, shrunk through the DevTools protocol: the write fails the way a full
// disk does, as an aborted transaction rather than a throwing put().
test('a real quota failure is reported, and saving resumes once there is room', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'The quota is shrunk through the Chrome DevTools protocol')
  const cdp = await page.context().newCDPSession(page)
  await loadAndMap(page)
  const origin = new URL(page.url()).origin
  await findSuggestions(page)
  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 1 })
  await confirmPair(page, 'Salary in')
  await page.getByLabel('Save this session in this browser').check()
  await expect(page.locator('.save-status')).toContainText("Not saved: This browser's storage for the page is full")
  await expect(page.locator('.session-bar .warning')).toContainText('reloading the page loses them')
  await cdp.send('Storage.overrideQuotaForOrigin', { origin })
  await confirmPair(page, 'Rent cheque')
  await expect(page.locator('.save-status')).toContainText(/Saved in this browser/)
  await expect(page.locator('.session-bar .warning')).toHaveCount(0)
  await page.reload()
  await page.getByRole('button', { name: /Reconcile/ }).click()
  await page.getByRole('button', { name: 'Resume it' }).click()
  await expect(page.getByText(/Loaded a session at revision \d+ with 2 decisions/)).toBeVisible()
})

test('without IndexedDB the page offers backups only and never claims to save', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true })
  })
  await loadAndMap(page)
  await findSuggestions(page)
  await confirmPair(page, 'Salary in')
  await expect(page.getByLabel('Save this session in this browser')).toHaveCount(0)
  await expect(page.locator('.save-status')).toContainText('Not saved in this browser')
  await expect(page.getByRole('button', { name: 'Export session backup' })).toBeEnabled()
})
test('a corrupted saved session is reported on resume and can be deleted', async ({ page }) => {
  await loadAndMap(page)
  await findSuggestions(page)
  await page.getByLabel('Save this session in this browser').check()
  await confirmPair(page, 'Salary in')
  await expect(page.locator('.save-status')).toContainText('Saved in this browser')
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('reconciliation', 1)
        open.onsuccess = () => {
          const tx = open.result.transaction('sessions', 'readwrite')
          tx.objectStore('sessions').put({ id: 'other', revision: 99, text: '{"format":"reconciliation-session","version":1' }, 'current')
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        }
      }),
  )
  await page.reload()
  await page.getByRole('button', { name: /Reconcile/ }).click()
  await page.getByRole('button', { name: 'Resume it' }).click()
  await expect(page.getByRole('alert')).toContainText("The session saved in this browser can't be read: The file is not valid JSON. Delete it to save again.")
  await page.getByRole('button', { name: 'Delete the session saved in this browser' }).click()
  await expect(page.getByRole('button', { name: 'Resume it' })).toHaveCount(0)
})

test('two tabs saving at the same moment: one saves, the other is refused and can resume without losing the saved decisions', async ({ page, context }) => {
  await loadAndMap(page)
  await findSuggestions(page)
  await page.getByLabel('Save this session in this browser').check()
  await confirmPair(page, 'Salary in')
  await expect(page.locator('.save-status')).toContainText('Saved in this browser')

  const other = await context.newPage()
  await other.goto('./')
  await other.getByRole('button', { name: /Reconcile/ }).click()
  await other.getByRole('button', { name: 'Resume it' }).click()
  await expect(other.getByText(/Loaded a session at revision \d+ with 1 decision\./)).toBeVisible()
  await loadFilesAgain(other)
  await findSuggestions(other)
  await expect(other.locator('.save-status')).toContainText('Saved in this browser')

  // Both confirm a different pair at once, from the same saved revision.
  await Promise.all([confirmPair(page, 'Rent'), confirmPair(other, 'Subscription')])
  const statuses = await Promise.all(
    [page, other].map(async (p) => {
      await expect(p.locator('.save-status')).not.toContainText('Saving')
      return (await p.locator('.save-status').textContent()) ?? ''
    }),
  )
  const refused = statuses.filter((s) => s.includes('Not saved: A newer revision is saved in this browser'))
  expect(refused).toHaveLength(1)
  expect(statuses.filter((s) => / Saved in this browser/.test(s))).toHaveLength(1)

  // The refused tab resumes the saved session: it has the other tab's decision, not its own.
  const loser = statuses[0].includes('Not saved') ? page : other
  await loser.getByRole('button', { name: 'Resume the saved session' }).click()
  await expect(loser.getByText(/Loaded a session at revision \d+ with 2 decisions\./)).toBeVisible()
  await loadFilesAgain(loser)
  await findSuggestions(loser)
  await expect(loser.getByRole('tab', { name: /^Confirmed/ }).locator('.tab-count')).toHaveText('2')
  await loser.getByRole('tab', { name: /^Confirmed/ }).click()
  await expect(loser.locator('.review-row', { hasText: loser === other ? 'Rent' : 'Subscription' })).toBeVisible()
})

// A file picked while a resume is still reading browser storage is read again with the
// session's layout once the resume finishes.
test('a file picked during a resume is read again with the session’s layout', async ({ page }) => {
  await loadAndMap(page)
  await findSuggestions(page)
  await page.getByLabel('Save this session in this browser').check()
  await confirmPair(page, 'Salary in')
  await expect(page.locator('.save-status')).toContainText('Saved in this browser')
  // Slow browser-storage reads, so the file below is always picked while the resume is
  // still reading the saved session.
  await page.addInitScript(() => {
    const get = IDBObjectStore.prototype.get
    IDBObjectStore.prototype.get = function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
      const request = get.call(this, query)
      Object.defineProperty(request, 'onsuccess', {
        set(handler: (event: Event) => void) {
          request.addEventListener('success', (event) => setTimeout(() => handler.call(request, event), 1_500))
        },
      })
      return request
    }
  })
  await page.reload()
  await page.getByRole('button', { name: /Reconcile/ }).click()
  const bank = page.locator('section.file-panel', { hasText: 'Bank statement' })
  await page.getByRole('button', { name: 'Resume it' }).click()
  await bank.getByLabel('Choose bank statement').setInputFiles({ name: 'bank.csv', mimeType: 'text/csv', buffer: Buffer.from(BANK) })
  await expect(page.getByText(/Loaded a session at revision \d+ with 1 decision\./)).toBeVisible()
  await expect(bank.locator('.file-stats')).toContainText('4 records')
})

async function loadFilesAgain(page: Page) {
  await loadFiles(page)
  await expect(page.getByLabel('Currency')).toHaveValue('INR')
}

test('after a cancel, carried items are sent to the worker again and their decisions still apply', async ({ page }) => {
  test.setTimeout(150_000)
  const lineage = (n: number) => `books|${'2'.repeat(64)}|${n}`
  const origin = (n: number) => ({ sessionId: 'sep', period: { start: '2026-09-01', end: '2026-09-30' }, fileName: 'books-sep.csv', fingerprint: '2'.repeat(64), recordNumber: n })
  const outstanding = JSON.stringify({
    format: 'reconciliation-outstanding',
    version: 1,
    exportedAt: '2026-10-01T00:00:00Z',
    sessionId: 'sep',
    account: '',
    currency: 'INR',
    minorUnits: 2,
    period: { start: '2026-09-01', end: '2026-09-30' },
    items: [{ lineage: lineage(3), side: 'books', date: '2026-09-29', amount: '-200.00', direction: 'out', reference: 'CHQ101', description: 'Cheque 101 issued', origin: origin(3) }],
    cleared: [],
  })
  // Filler rows that match nothing make reading slow enough to cancel.
  const books = 'date,amount,ref,memo\n2026-10-30,500.00,,Receipt\n' + '2026-10-01,1.23,,Filler\n'.repeat(600_000)
  await setUpMonth(page, { bank: 'date,amount,ref,memo\n02/10/2026,-200.00,CHQ101,Cheque 101 cleared\n', books }, ['2026-10-01', '2026-10-31'], ['1300.00', '1100.00', '1100.00', '0'])
  await page.getByLabel('Import outstanding items file').setInputFiles({ name: 'outstanding.json', mimeType: 'application/json', buffer: Buffer.from(outstanding) })
  await findSuggestions(page)
  const carried = page.locator('.review-row', { hasText: 'Cheque 101 cleared' }).first()
  await expect(carried).toContainText('Carried · Books record 3 of books-sep.csv')
  await carried.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByRole('tab', { name: /^Confirmed/ }).locator('.tab-count')).toHaveText('1')

  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await choose(page, 'Books CSV delimiter', 'Comma')
  await expect(page.locator('.activity-row', { hasText: 'Reading books' })).toBeVisible()
  await page.locator('.activity').getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Read bank.csv again' }).click()
  const booksPanel = page.locator('section.file-panel', { hasText: 'Your ledger' })
  await booksPanel.getByRole('button', { name: 'Read books.csv again' }).click()
  await expect(booksPanel.locator('.file-stats')).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Map dates and amounts' }).click()
  await expect(page.locator('.opening-files')).toContainText('outstanding.json')
  await findSuggestions(page)
  await expect(page.getByRole('tab', { name: /^Confirmed/ }).locator('.tab-count')).toHaveText('1')
  await page.getByRole('tab', { name: /^Confirmed/ }).click()
  await expect(page.locator('.review-row').first()).toContainText('Carried · Books record 3 of books-sep.csv')
})

test.describe('period dates', () => {
  test.use({ locale: 'en-IN' })

  test('can be typed into the date fields in the browser’s order, and stay after leaving the step', async ({ page }) => {
    await loadAndMap(page)
    await typeDate(page, 'Period start', '2026-09-01')
    await typeDate(page, 'Period end', '2026-08-31')
    await expect(page.getByText('The period ends before it starts.')).toBeVisible()
    await page.getByLabel('Period end').fill('')
    await typeDate(page, 'Period end', '2026-09-30')
    await expect(page.getByLabel('Period start')).toHaveValue('2026-09-01')
    await expect(page.getByLabel('Period end')).toHaveValue('2026-09-30')
    await page.getByRole('button', { name: 'Back to files' }).click()
    await page.getByRole('button', { name: 'Map dates and amounts' }).click()
    await expect(page.getByLabel('Period start')).toHaveValue('2026-09-01')
    await expect(page.getByLabel('Period end')).toHaveValue('2026-09-30')
    await page.getByLabel('Save this session in this browser').check()
    await expect(page.locator('.save-status')).toContainText('Saved in this browser')
    await page.reload()
    await page.getByRole('button', { name: /Reconcile/ }).click()
    await page.getByRole('button', { name: 'Resume it' }).click()
    await expect(page.getByText(/Loaded a session/)).toBeVisible()
    await loadFilesAgain(page)
    await expect(page.getByLabel('Period start')).toHaveValue('2026-09-01')
    await expect(page.getByLabel('Period end')).toHaveValue('2026-09-30')
  })

  test('a half-entered period is shown, flagged, and kept out of the saved session', async ({ page }) => {
    await loadAndMap(page)
    await page.getByLabel('Period start').fill('2026-09-01')
    await expect(page.getByText('Enter both the start and the end of the period.')).toBeVisible()
    await findSuggestions(page)
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export session backup' }).click()
    const chunks: Buffer[] = []
    for await (const chunk of await (await download).createReadStream()) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString()
    expect(JSON.parse(text).accounting.period).toBeNull()
    await page.reload()
    await page.getByRole('button', { name: /Reconcile/ }).click()
    await page.getByLabel('Import session file').setInputFiles({ name: 's.json', mimeType: 'application/json', buffer: Buffer.from(text) })
    await expect(page.getByText(/Loaded a session/)).toBeVisible()
  })
})
