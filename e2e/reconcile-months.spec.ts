import { expect, type Page, test } from '@playwright/test'
import * as XLSX from 'xlsx'
import type { OutstandingFile } from '../src/reconciliation/carryforward'
import { choose, classifyAll, setUpMonth as setUp } from './reconcile-helpers'

const BANK_SEP = 'date,amount,ref,memo\n11/09/2026,300.00,,Receipt\n'
const BOOKS_SEP = 'date,amount,ref,memo\n2026-09-10,300.00,,Receipt\n2026-09-15,-50.00,CHQ102,Cheque 102 issued\n2026-09-29,-200.00,CHQ101,Cheque 101 issued\n'
const BANK_OCT = 'date,amount,ref,memo,balance\n02/10/2026,-200.00,CHQ101,Cheque 101 cleared,1100.00\n20/10/2026,-50.00,CHQ102,Cheque 102 cleared,1050.00\n31/10/2026,-10.00,,Bank charge,1040.00\n'
const BOOKS_OCT = 'date,amount,ref,memo\n2026-10-30,500.00,,Receipt\n'

function septemberOutstanding(): OutstandingFile {
  const fingerprint = '2'.repeat(64)
  const period = { start: '2026-09-01', end: '2026-09-30' }
  return {
    format: 'reconciliation-outstanding',
    version: 1,
    exportedAt: '2026-10-01T00:00:00Z',
    sessionId: 'sep',
    account: '',
    currency: 'INR',
    minorUnits: 2,
    period,
    items: [{
      lineage: `books|${fingerprint}|3`,
      side: 'books',
      date: '2026-09-29',
      amount: '-200.00',
      direction: 'out',
      reference: 'CHQ101',
      description: 'Cheque 101 issued',
      origin: { sessionId: 'sep', period, fileName: 'books-sep.csv', fingerprint, recordNumber: 3 },
    }],
    cleared: [],
  }
}

async function importOutstanding(page: Page, name: string, file: OutstandingFile) {
  await page.getByLabel('Import outstanding items file').setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(file)),
  })
  await expect(page.locator('.opening-files')).toContainText(name)
}

async function downloaded(page: Page, click: () => Promise<void>): Promise<Buffer> {
  const event = page.waitForEvent('download')
  await click()
  const chunks: Buffer[] = []
  for await (const chunk of await (await event).createReadStream()) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

test('September’s outstanding cheques carry into October, clear there, and only new items carry on', async ({ page }) => {
  // Two full months through the UI; slower when the suite runs its large-file tests alongside.
  test.setTimeout(60_000)
  const panel = page.getByRole('region', { name: 'Reconciliation status' })

  await setUp(page, { bank: BANK_SEP, books: BOOKS_SEP }, ['2026-09-01', '2026-09-30'], ['1000.00', '1300.00', '1000.00', '1050.00'])
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await page.locator('.review-row', { hasText: 'Receipt' }).first().getByRole('button', { name: 'Confirm' }).click()
  await classifyAll(page)
  await panel.getByRole('button', { name: 'Mark reconciliation complete' }).click()
  await expect(panel).toContainText('Reconciliation completed: yes')
  const download = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export outstanding items' }).click()
  const september = await (await download).createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of september) chunks.push(Buffer.from(chunk))
  const outstanding = Buffer.concat(chunks).toString()
  expect(JSON.parse(outstanding).items.map((i: { amount: string }) => i.amount)).toEqual(['-50.00', '-200.00'])

  await page.reload()
  await setUp(page, { bank: BANK_OCT, books: BOOKS_OCT }, ['2026-10-01', '2026-10-31'], ['1300.00', '1040.00', '1050.00', '1550.00'])
  await choose(page, 'Bank statement running balance column', 'balance')
  await page.getByLabel('Import outstanding items file').setInputFiles({ name: 'outstanding-2026-09-30.json', mimeType: 'application/json', buffer: Buffer.from(outstanding) })
  await expect(page.locator('.opening-files')).toContainText('2026-09-01 to 2026-09-30 · 2 outstanding items')
  await page.getByRole('button', { name: 'Check mapping' }).click()
  await expect(page.getByText(/Opening items: 0 bank items and 2 books items carried/)).toBeVisible()
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  for (const cheque of ['Cheque 101', 'Cheque 102']) {
    const row = page.locator('.review-row', { hasText: `${cheque} cleared` }).first()
    await expect(row).toContainText('Carried · Books record')
    await row.getByRole('button', { name: 'Confirm' }).click()
  }
  await classifyAll(page)
  await expect(panel).toContainText('Bank running balance: consistent with every record')
  await panel.getByRole('button', { name: 'Mark reconciliation complete' }).click()
  await expect(panel).toContainText('Reconciliation completed: yes')
  const next = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export outstanding items' }).click()
  const october = await (await next).createReadStream()
  const parts: Buffer[] = []
  for await (const chunk of october) parts.push(Buffer.from(chunk))
  const carried = JSON.parse(Buffer.concat(parts).toString())
  expect(carried.items.map((i: { description: string }) => i.description)).toEqual(['Bank charge', 'Receipt'])
  expect(carried.cleared).toHaveLength(2)

  const report = JSON.parse((await downloaded(page, () => panel.getByRole('button', { name: 'Report (JSON)' }).click())).toString())
  expect(report.statuses.completed).toEqual({ earned: true, reasons: [] })
  expect(report.matches).toHaveLength(2)
  expect(report.running.bank).toBe('consistent with every record')
  const workbook = XLSX.read(await downloaded(page, () => panel.getByRole('button', { name: 'Report (Excel)' }).click()))
  expect(workbook.SheetNames).toEqual(['Summary', 'Matches', 'Outstanding', 'Group members', 'Problems', 'Decisions'])
  expect(XLSX.utils.sheet_to_json<string[]>(workbook.Sheets.Summary, { header: 1 })).toContainEqual(['Reconciliation completed', 'Yes'])
})

test('an outstanding-items file from the same period is refused at the mapping check', async ({ page }) => {
  await setUp(page, { bank: BANK_SEP, books: BOOKS_SEP }, ['2026-09-01', '2026-09-30'], ['1000.00', '1300.00', '1000.00', '1050.00'])
  const file = JSON.stringify({ format: 'reconciliation-outstanding', version: 1, exportedAt: '2026-10-01T00:00:00Z', sessionId: 's', account: '', currency: 'INR', minorUnits: 2, period: { start: '2026-09-01', end: '2026-09-30' }, items: [], cleared: [] })
  await page.getByLabel('Import outstanding items file').setInputFiles({ name: 'same.json', mimeType: 'application/json', buffer: Buffer.from(file) })
  await page.getByRole('button', { name: 'Check mapping' }).click()
  await expect(page.getByRole('alert')).toContainText("same.json: The file's period ends 2026-09-30, not before this session's period starts (2026-09-01)")
})

test('loading a backup without opening items drops the ones imported before', async ({ page }) => {
  test.setTimeout(60_000)
  const october = { bank: 'date,amount,ref,memo\n02/10/2026,-200.00,CHQ101,Cheque 101 cleared\n', books: 'date,amount,ref,memo\n2026-10-30,500.00,,Receipt\n' }
  await setUp(page, october, ['2026-10-01', '2026-10-31'], ['1300.00', '1100.00', '1050.00', '1550.00'])
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await expect(page.getByRole('heading', { name: 'Review pairs' })).toBeVisible()
  const backup = (await downloaded(page, () => page.getByRole('button', { name: 'Export session backup' }).click())).toString()
  expect(JSON.parse(backup).opening).toEqual([])

  const outstanding = JSON.stringify({
    format: 'reconciliation-outstanding', version: 1, exportedAt: '2026-10-01T00:00:00Z', sessionId: 'sep', account: '', currency: 'INR', minorUnits: 2,
    period: { start: '2026-09-01', end: '2026-09-30' },
    items: [{ lineage: `books|${'2'.repeat(64)}|3`, side: 'books', date: '2026-09-29', amount: '-200.00', direction: 'out', reference: 'CHQ101', description: 'Cheque 101 issued', origin: { sessionId: 'sep', period: { start: '2026-09-01', end: '2026-09-30' }, fileName: 'books-sep.csv', fingerprint: '2'.repeat(64), recordNumber: 3 } }],
    cleared: [],
  })
  await page.getByRole('button', { name: 'Edit mapping' }).click()
  await page.getByLabel('Import outstanding items file').setInputFiles({ name: 'outstanding.json', mimeType: 'application/json', buffer: Buffer.from(outstanding) })
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await expect(page.locator('.review-row', { hasText: 'Carried · Books record 3' }).first()).toBeVisible()

  await page.getByLabel('Import session file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) })
  await expect(page.getByText(/Loaded a session/)).toBeVisible()
  await page.getByRole('button', { name: 'Map dates and amounts' }).click()
  await expect(page.locator('.opening-files')).toHaveCount(0)
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await expect(page.getByRole('heading', { name: 'Review pairs' })).toBeVisible()
  await page.getByRole('tab', { name: /^Unmatched/ }).click()
  await expect(page.locator('.review-row').first()).toBeVisible()
  await expect(page.getByText(/Carried ·/)).toHaveCount(0)
})

test('a repeated carried row in an overlapping source export warns and blocks completion without discarding either row', async ({ page }) => {
  const books = 'date,amount,ref,memo\n2026-09-29,-200.00,CHQ101,Cheque 101 issued\n2026-10-30,500.00,,Receipt\n'
  await setUp(page, {
    bank: 'date,amount,ref,memo\n02/10/2026,-200.00,CHQ101,Cheque 101 cleared\n',
    books,
  }, ['2026-10-01', '2026-10-31'], ['1300.00', '1100.00', '1100.00', '1600.00'])
  await importOutstanding(page, 'sep.json', septemberOutstanding())
  await page.getByRole('button', { name: 'Check mapping' }).click()
  const check = page.getByRole('region', { name: 'Mapping check' })
  await expect(check).toContainText('an overlapping export')
  await expect(check).toContainText("may repeat record 1 of this period's books file")
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  const panel = page.getByRole('region', { name: 'Reconciliation status' })
  await expect(panel).toContainText('Books: opening plus movements does not equal the closing balance')
  await expect(panel.getByRole('button', { name: 'Mark reconciliation complete' })).toBeDisabled()
  const report = JSON.parse((await downloaded(page, () => panel.getByRole('button', { name: 'Report (JSON)' }).click())).toString())
  expect(report.counts.books).toMatchObject({ rows: 2, opening: 1 })
  expect(report.outstanding.filter((o: { transaction: { side: string } }) => o.transaction.side === 'books')).toHaveLength(3)
  expect(report.statuses.completed.earned).toBe(false)
})

test('two carry exports containing the same lineage are refused until the duplicate is removed', async ({ page }) => {
  await setUp(page, { bank: BANK_OCT, books: BOOKS_OCT }, ['2026-10-01', '2026-10-31'], ['1300.00', '1040.00', '1100.00', '1600.00'])
  const file = septemberOutstanding()
  await importOutstanding(page, 'sep-a.json', file)
  await importOutstanding(page, 'sep-b.json', file)
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await expect(page.getByRole('alert')).toContainText(`${file.items[0].lineage} is already imported into this session`)
  await expect(page.getByRole('heading', { name: 'Review pairs' })).toHaveCount(0)
  await page.locator('.opening-files li', { hasText: 'sep-b.json' }).getByRole('button', { name: 'Remove' }).click()
  await page.getByRole('button', { name: 'Check mapping' }).click()
  await expect(page.getByRole('region', { name: 'Mapping check' })).toContainText('1 books item carried')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('clearances survive re-export and stale outstanding items are refused in either import order', async ({ page }) => {
  test.setTimeout(60_000)
  const previous = septemberOutstanding()
  const inherited = `books|${'2'.repeat(64)}|7`
  previous.cleared = [inherited]
  await setUp(page, {
    bank: 'date,amount,ref,memo\n02/10/2026,-200.00,CHQ101,Cheque 101 cleared\n',
    books: BOOKS_OCT,
  }, ['2026-10-01', '2026-10-31'], ['1300.00', '1100.00', '1100.00', '1600.00'])
  await importOutstanding(page, 'sep.json', previous)
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await page.locator('.review-row', { hasText: 'Cheque 101 cleared' }).getByRole('button', { name: 'Confirm' }).click()
  const panel = page.getByRole('region', { name: 'Reconciliation status' })
  const next: OutstandingFile = JSON.parse((await downloaded(page, () => panel.getByRole('button', { name: 'Export outstanding items' }).click())).toString())
  expect(next.cleared.sort()).toEqual([previous.items[0].lineage, inherited].sort())
  expect(next.items.map((item) => item.description)).toEqual(['Receipt'])

  await setUp(page, {
    bank: 'date,amount,ref,memo\n01/11/2026,-10.00,,Fee\n',
    books: 'date,amount,ref,memo\n2026-11-01,600.00,,New receipt\n',
  }, ['2026-11-01', '2026-11-30'], ['1100.00', '1090.00', '1600.00', '2200.00'])
  await importOutstanding(page, 'oct.json', next)
  await importOutstanding(page, 'stale-sep.json', previous)
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await expect(page.getByRole('alert')).toContainText(`${previous.items[0].lineage} was already cleared`)
  await expect(page.getByRole('heading', { name: 'Review pairs' })).toHaveCount(0)
  await page.locator('.opening-files li', { hasText: 'stale-sep.json' }).getByRole('button', { name: 'Remove' }).click()
  await page.getByRole('button', { name: 'Check mapping' }).click()
  await expect(page.getByRole('region', { name: 'Mapping check' })).toContainText('1 books item carried')
  await expect(page.getByRole('alert')).toHaveCount(0)

  await page.locator('.opening-files li', { hasText: 'oct.json' }).getByRole('button', { name: 'Remove' }).click()
  await importOutstanding(page, 'stale-sep.json', previous)
  await importOutstanding(page, 'oct.json', next)
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await expect(page.getByRole('alert')).toContainText(`${previous.items[0].lineage} was cleared, but it is imported here as outstanding`)
  await expect(page.getByRole('heading', { name: 'Review pairs' })).toHaveCount(0)
})

for (const running of ['consistent', 'broken', 'unreadable'] as const) {
  test(`liability balances convert once and ${running} running balances determine whether completion is allowed`, async ({ page }) => {
    const firstBalance = running === 'consistent' ? '1010.00' : running === 'broken' ? '1009.00' : ''
    await setUp(page, {
      bank: `date,amount,ref,memo,balance\n01/10/2026,-10.00,P1,Payment,${firstBalance}\n02/10/2026,-5.00,P2,Fee,1015.00\n`,
      books: 'date,amount,ref,memo\n2026-10-01,-10.00,P1,Payment\n2026-10-02,-5.00,P2,Fee\n',
    }, ['2026-10-01', '2026-10-31'], ['1000.00', '1015.00', '1000.00', '1015.00'])
    await choose(page, 'Bank balance basis', 'Amount owed (a credit card or loan)')
    await choose(page, 'Books balance basis', 'Amount owed (a credit card or loan)')
    await choose(page, 'Bank statement running balance column', 'balance')
    await page.getByRole('button', { name: 'Find suggestions' }).click()
    for (const text of ['Payment', 'Fee']) {
      await page.locator('.review-row', { hasText: text }).getByRole('button', { name: 'Confirm' }).click()
    }
    const panel = page.getByRole('region', { name: 'Reconciliation status' })
    const complete = panel.getByRole('button', { name: 'Mark reconciliation complete' })
    if (running === 'consistent') {
      await expect(panel).toContainText('Source balances validated: yes')
      await expect(panel).toContainText('Bank running balance: consistent with every record')
      await expect(complete).toBeEnabled()
      await complete.click()
      await expect(panel).toContainText('Reconciliation completed: yes')
    } else {
      await expect(panel).toContainText('Source balances validated: not yet')
      await expect(panel).toContainText(running === 'broken'
        ? 'breaks at record 1: expected -1010.00, found -1009.00'
        : "can't be checked past record 1")
      await expect(complete).toBeDisabled()
    }
    const report = JSON.parse((await downloaded(page, () => panel.getByRole('button', { name: 'Report (JSON)' }).click())).toString())
    expect(report.balances.cash).toEqual({
      bank: { opening: '-1000.00', closing: '-1015.00' },
      books: { opening: '-1000.00', closing: '-1015.00' },
    })
    expect(report.statuses.completed.earned).toBe(running === 'consistent')
  })
}
