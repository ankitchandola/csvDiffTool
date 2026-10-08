// Measures Reconcile sessions with many decisions in Chrome on a production build:
// importing a session backup, replaying its history after "Find suggestions", saving it
// in browser storage (IndexedDB), and exporting it again.
//
//   npm run build && npm run bench:session
//   npm run bench:session -- --only=10000
//
// Each case is N bank and N books rows with distinct amounts, so every pair is an exact
// 1:1 match, and a session confirming all N pairs. Memory is Chrome's process-tree
// resident size above a baseline, sampled every 50 ms: rough, not a bound.
import { createHash } from 'node:crypto'
import { cpus, totalmem } from 'node:os'
import { chromium, type Page } from '@playwright/test'
import { processTreeRss, sampler, startPreview, URL } from './browser'

const MB = 2 ** 20
const SIZES = [1_000, 10_000, 50_000]

function money(i: number): string {
  const units = 100 + i
  return `${Math.floor(units / 100)}.${String(units % 100).padStart(2, '0')}`
}

function day(i: number): number {
  return 1 + (i % 28)
}

function files(n: number) {
  const bank = ['date,amount,memo']
  const books = ['date,amount,memo']
  for (let i = 0; i < n; i++) {
    bank.push(`${String(day(i)).padStart(2, '0')}/09/2026,${money(i)},payment ${i}`)
    books.push(`2026-09-${String(day(i)).padStart(2, '0')},${money(i)},payment ${i}`)
  }
  return { bank: Buffer.from(bank.join('\n') + '\n'), books: Buffer.from(books.join('\n') + '\n') }
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function session(n: number, bank: Buffer, books: Buffer): string {
  const fp = { bank: sha256(bank), books: sha256(books) }
  const mapping = (format: string) => ({
    delimiter: ',',
    layout: { headerRecord: 1, skipLeading: 0, skipTrailing: 0 },
    date: { column: 'date', format, kind: 'posting' },
    amount: { kind: 'signed', column: 'amount', positiveIs: 'in' },
    amountFormat: { grouped: false, trailingMinus: false, parentheses: false },
    reference: null,
    description: 'memo',
    balance: null,
    balanceMarks: 'none',
  })
  const events = []
  const snapshots = []
  for (let i = 0; i < n; i++) {
    const bankKey = `bank|${fp.bank}|${i + 1}`
    const booksKey = `books|${fp.books}|${i + 1}`
    events.push({ seq: i + 1, at: '2026-10-08T00:00:00.000Z', action: 'confirm', bank: bankKey, books: booksKey, origin: 'suggested' })
    const date = `2026-09-${String(day(i)).padStart(2, '0')}`
    snapshots.push({ key: bankKey, date, amount: money(i), direction: 'in', reference: null, description: `payment ${i}` })
    snapshots.push({ key: booksKey, date, amount: money(i), direction: 'in', reference: null, description: `payment ${i}` })
  }
  return JSON.stringify({
    format: 'reconciliation-session',
    version: 1,
    id: 'bench',
    savedAt: '2026-10-08T00:00:00.000Z',
    revision: n,
    context: { account: '', currency: 'INR', minorUnits: 2 },
    mappings: { bank: mapping('DD/MM/YYYY'), books: mapping('YYYY-MM-DD') },
    rules: { bankDaysBefore: 3, bankDaysAfter: 3, referencesShared: false, referenceCaseInsensitive: false },
    sources: { bank: { fileName: 'bank.csv', fingerprint: fp.bank, sheet: null, recordCount: n }, books: { fileName: 'books.csv', fingerprint: fp.books, sheet: null, recordCount: n } },
    events,
    snapshots,
    accounting: { period: null, balances: { bank: { opening: null, closing: null, basis: 'cash' }, books: { opening: null, closing: null, basis: 'cash' } } },
    opening: [],
  })
}

async function timed(action: () => Promise<unknown>): Promise<number> {
  const start = performance.now()
  await action()
  return (performance.now() - start) / 1000
}

async function runCase(n: number, root: number, page: Page) {
  const { bank, books } = files(n)
  const backup = session(n, bank, books)
  await page.goto(URL)
  await page.getByRole('button', { name: /Reconcile/ }).click()
  const baseline = processTreeRss(root)
  const memory = sampler(root)
  const importS = await timed(async () => {
    await page.getByLabel('Import session file').setInputFiles({ name: 'session.json', mimeType: 'application/json', buffer: Buffer.from(backup) })
    await page.getByText(`Loaded a session at revision ${n.toLocaleString('en-US')} with ${n.toLocaleString('en-US')} decisions.`).waitFor({ timeout: 300_000 })
  })
  await page.getByLabel('Choose bank statement').setInputFiles({ name: 'bank.csv', mimeType: 'text/csv', buffer: bank })
  await page.getByLabel('Choose books').setInputFiles({ name: 'books.csv', mimeType: 'text/csv', buffer: books })
  await page.getByRole('button', { name: 'Map dates and amounts' }).click({ timeout: 300_000 })
  const replayS = await timed(async () => {
    await page.getByRole('button', { name: 'Find suggestions' }).click()
    await page.getByRole('tab', { name: /^Confirmed/ }).locator('.tab-count').filter({ hasText: n.toLocaleString('en-US') }).waitFor({ timeout: 300_000 })
  })
  const saveS = await timed(async () => {
    await page.getByLabel('Save this session in this browser').check()
    await page.locator('.save-status').filter({ hasText: / Saved in this browser/ }).waitFor({ timeout: 300_000 })
  })
  // Five quick decisions while saving is on: superseded saves collapse into one.
  await page.getByRole('tab', { name: /^Confirmed/ }).click()
  const burstS = await timed(async () => {
    for (let i = 0; i < 5; i++) {
      await page.locator('.review-row').first().getByRole('button', { name: 'Unmatch' }).click()
      await page.getByRole('tab', { name: /^Confirmed/ }).locator('.tab-count').filter({ hasText: (n - i - 1).toLocaleString('en-US') }).waitFor({ timeout: 300_000 })
    }
    await page.locator('.save-status').filter({ hasText: `Revision ${(n + 5).toLocaleString('en-US')} · ` }).filter({ hasText: / Saved in this browser/ }).waitFor({ timeout: 300_000 })
  })
  let backupBytes = 0
  const exportS = await timed(async () => {
    const download = page.waitForEvent('download', { timeout: 300_000 })
    await page.getByRole('button', { name: 'Export session backup' }).click()
    const stream = await (await download).createReadStream()
    for await (const chunk of stream) backupBytes += (chunk as Buffer).length
  })
  const peak = memory.stop()
  return {
    decisions: n,
    sessionMiB: (Buffer.byteLength(backup) / MB).toFixed(1),
    backupMiB: (backupBytes / MB).toFixed(1),
    importS: importS.toFixed(1),
    replayS: replayS.toFixed(1),
    saveS: saveS.toFixed(1),
    burstS: burstS.toFixed(1),
    exportS: exportS.toFixed(1),
    peakAboveMiB: Math.round((peak - baseline) / MB),
  }
}

async function main() {
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length)
  const sizes = only ? SIZES.filter((n) => String(n) === only) : SIZES
  const server = await startPreview()
  try {
    console.log(`${cpus()[0].model}, ${Math.round(totalmem() / 2 ** 30)} GiB RAM, Node ${process.version}`)
    for (const n of sizes) {
      const browserServer = await chromium.launchServer({ channel: 'chrome' })
      const browser = await chromium.connect(browserServer.wsEndpoint())
      try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
        if (n === sizes[0]) console.log(`Chrome ${browser.version()}`)
        console.log(JSON.stringify(await runCase(n, browserServer.process().pid as number, page)))
      } finally {
        await browser.close()
        await browserServer.close()
      }
    }
  } finally {
    server.kill()
  }
}

await main()
