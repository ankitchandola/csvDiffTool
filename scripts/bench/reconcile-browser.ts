// Drives Reconcile in Chrome on a production build and records time and Chrome
// process-tree memory for dense, repeated-amount inputs, where candidate search and
// conflict analysis do the most work.
//
//   npm run build && npm run bench:reconcile
//   npm run bench:reconcile -- --only=dense-3000
//
// Memory is the summed resident set size of Chrome's processes, sampled every 50 ms,
// above a baseline taken once both files are read. Sampling can miss short peaks, so
// peaks are lower bounds. Timings include the UI round trip, not only worker time.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { cpus, totalmem } from 'node:os'
import { chromium, type Page } from '@playwright/test'

const PORT = 4177
const URL = `http://127.0.0.1:${PORT}/`
const MB = 2 ** 20

interface Case {
  name: string
  // Rows per side; row i gets amounts(i) units of 0.01 on day days(i) of September 2026.
  rows: number
  amount: (i: number) => number
  day: (i: number) => number
}

const CASES: Case[] = [
  { name: 'dense-1000', rows: 1_000, amount: () => 10_000, day: () => 1 },
  { name: 'dense-1414', rows: 1_414, amount: () => 10_000, day: () => 1 },
  { name: 'dense-3000', rows: 3_000, amount: () => 10_000, day: () => 1 },
  { name: 'dense-20000', rows: 20_000, amount: () => 10_000, day: () => 1 },
  { name: 'repeated-50000', rows: 50_000, amount: (i) => 10_000 + (i % 500), day: (i) => 1 + (Math.floor(i / 500) % 30) },
  { name: 'distinct-200000', rows: 200_000, amount: (i) => 100 + i, day: (i) => 1 + (i % 30) },
]

function csv(header: string, rows: number, line: (i: number) => string): Buffer {
  const parts = [header]
  for (let i = 0; i < rows; i++) parts.push(line(i))
  return Buffer.from(parts.join('\n') + '\n')
}

function amountText(units: number): string {
  return `${Math.floor(units / 100)}.${String(units % 100).padStart(2, '0')}`
}

function processTreeRss(root: number): number {
  const lines = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=']).toString().trim().split('\n')
  const children = new Map<number, number[]>()
  const rss = new Map<number, number>()
  for (const line of lines) {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number)
    rss.set(pid, kb * 1024)
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }
  let total = 0
  const stack = [root]
  while (stack.length > 0) {
    const pid = stack.pop() as number
    total += rss.get(pid) ?? 0
    stack.push(...(children.get(pid) ?? []))
  }
  return total
}

function sampler(root: number) {
  let peak = 0
  const timer = setInterval(() => {
    peak = Math.max(peak, processTreeRss(root))
  }, 50)
  return {
    stop() {
      clearInterval(timer)
      return Math.max(peak, processTreeRss(root))
    },
  }
}

async function choose(page: Page, label: string, option: string) {
  const trigger = page.getByRole('combobox', { name: label, exact: true })
  await trigger.scrollIntoViewIfNeeded()
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await trigger.click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

async function startPreview(): Promise<ChildProcess> {
  const server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(URL)).ok) return server
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  server.kill()
  throw new Error('vite preview did not start; run npm run build first')
}

async function runCase(c: Case, root: number, page: Page) {
  await page.goto(URL)
  await page.getByRole('button', { name: /Reconcile/ }).click()
  const bank = csv('date,amount', c.rows, (i) => `${String(c.day(i)).padStart(2, '0')}/09/2026,${amountText(c.amount(i))}`)
  const books = csv('date,amount', c.rows, (i) => `2026-09-${String(c.day(i)).padStart(2, '0')},${amountText(c.amount(i))}`)
  const readStart = performance.now()
  await page.getByLabel('Choose bank statement').setInputFiles({ name: 'bank.csv', mimeType: 'text/csv', buffer: bank })
  await page.getByLabel('Choose books').setInputFiles({ name: 'books.csv', mimeType: 'text/csv', buffer: books })
  await page.getByRole('button', { name: 'Map dates and amounts' }).click({ timeout: 120_000 })
  const readMs = performance.now() - readStart
  await page.getByLabel('Currency').fill('INR')
  await choose(page, 'Bank statement date column', 'date')
  await choose(page, 'Bank statement date format', 'DD/MM/YYYY')
  await choose(page, 'Bank statement amount column', 'amount')
  await choose(page, 'Books date column', 'date')
  await choose(page, 'Books date format', 'YYYY-MM-DD')
  await choose(page, 'Books amount column', 'amount')

  const checkStart = performance.now()
  await page.getByRole('button', { name: 'Check mapping' }).click()
  await page.getByRole('region', { name: 'Mapping check' }).waitFor({ timeout: 120_000 })
  const checkMs = performance.now() - checkStart

  const baseline = processTreeRss(root)
  const memory = sampler(root)
  const matchStart = performance.now()
  await page.getByRole('button', { name: 'Find suggestions' }).click()
  await page.getByRole('heading', { name: 'Suggested pairs' }).waitFor({ timeout: 300_000 })
  await page.locator('.suggestion').first().waitFor({ timeout: 120_000 })
  const findMs = performance.now() - matchStart

  const lastStart = performance.now()
  await page.locator('.vlist').evaluate((list) => {
    list.scrollTop = list.scrollHeight
  })
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.vlist-row')]
    return rows.length > 0 && rows.every((row) => !row.textContent?.includes('…'))
  }, undefined, { timeout: 120_000 })
  const lastPageMs = performance.now() - lastStart
  const peak = memory.stop()

  const metrics = await page.locator('.metric strong').allTextContents()
  const incomplete = (await page.getByText('Incomplete search:').count()) > 0
  return {
    name: c.name,
    rows: c.rows,
    pairs: metrics[0],
    groups: metrics[1],
    incomplete,
    readS: (readMs / 1000).toFixed(1),
    checkS: (checkMs / 1000).toFixed(1),
    findS: (findMs / 1000).toFixed(1),
    lastPageS: (lastPageMs / 1000).toFixed(2),
    baselineMiB: Math.round(baseline / MB),
    peakAboveMiB: Math.round((peak - baseline) / MB),
  }
}

async function main() {
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length)
  const cases = only ? CASES.filter((c) => c.name === only) : CASES
  const server = await startPreview()
  try {
    console.log(`${cpus()[0].model}, ${Math.round(totalmem() / 2 ** 30)} GiB RAM, Node ${process.version}`)
    for (const c of cases) {
      // A fresh browser per case, so one case's memory does not raise the next baseline.
      const browserServer = await chromium.launchServer({ channel: 'chrome' })
      const browser = await chromium.connect(browserServer.wsEndpoint())
      try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
        if (c === cases[0]) console.log(`Chrome ${browser.version()}`)
        console.log(JSON.stringify(await runCase(c, browserServer.process().pid as number, page)))
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
