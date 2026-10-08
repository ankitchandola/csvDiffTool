// Times each Reconcile worker request in Node, without a browser: reading, normalizing,
// matching, review pages and search, the status refresh after each decision, and the
// exports. It isolates worker cost from rendering and storage.
//
//   npm run bench:worker
//   npm run bench:worker -- --rows=50000
//
// N bank and N books rows with distinct amounts on 28 days, so every pair is an exact 1:1
// match. The bank side has a running balance column and both sides stated balances, so the
// status refresh includes the running-balance check.
import { cpus, totalmem } from 'node:os'
import { emptyAccounting } from '../../src/reconciliation/session'
import { DEFAULT_MATCHING, type SideMapping } from '../../src/reconciliation/types'
import { createReconcileHandler } from '../../src/worker/reconcile-handler'
import type { ReconRequests } from '../../src/worker/reconcile-protocol'

const rowsArg = process.argv.find((a) => a.startsWith('--rows='))
const N = rowsArg ? Number(rowsArg.slice('--rows='.length)) : 200_000

const two = (n: number) => String(n).padStart(2, '0')
const money = (paise: number) => `${paise < 0 ? '-' : ''}${Math.floor(Math.abs(paise) / 100)}.${two(Math.abs(paise) % 100)}`

let balance = 0
const bank = ['date,amount,ref,memo,balance']
const books = ['date,amount,ref,memo']
for (let i = 0; i < N; i++) {
  const paise = (i + 1) * (i % 2 ? -1 : 1)
  balance += paise
  const day = two((i % 28) + 1)
  bank.push(`${day}/09/2026,${money(paise)},R${i},Bank row ${i},${money(balance)}`)
  books.push(`2026-09-${day},${money(paise)},R${i},Books row ${i}`)
}

function mapping(format: 'DD/MM/YYYY' | 'YYYY-MM-DD', balanceColumn: string | null): SideMapping {
  return {
    delimiter: ',',
    layout: { headerRecord: 1, skipLeading: 0, skipTrailing: 0 },
    date: { column: 'date', format, kind: 'posting' },
    amount: { kind: 'signed', column: 'amount', positiveIs: 'in' },
    amountFormat: { grouped: false, trailingMinus: false, parentheses: false },
    reference: 'ref',
    description: 'memo',
    balance: balanceColumn,
  }
}

const handle = createReconcileHandler()
let id = 1
const call = <K extends keyof ReconRequests>(type: K, payload: ReconRequests[K]) => handle({ id: id++, type, ...payload } as never) as Promise<any>

const results: Record<string, number> = {}
async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now()
  const value = await work()
  results[label] = Math.round(performance.now() - start)
  return value
}

async function main() {
  console.log(`${cpus()[0].model}, ${Math.round(totalmem() / 2 ** 30)} GiB RAM, Node ${process.version}, ${N.toLocaleString('en-US')} rows per side`)
  const layout = { headerRecord: 1, skipLeading: 0, skipTrailing: 0 }
  await timed('read bank', () => call('parse', { side: 'bank', file: new File([bank.join('\n')], 'bank.csv'), delimiter: ',', layout }))
  await timed('read books', () => call('parse', { side: 'books', file: new File([books.join('\n')], 'books.csv'), delimiter: ',', layout }))
  const context = { account: '', currency: 'INR', minorUnits: 2 }
  const period = { start: '2026-09-01', end: '2026-09-30' }
  const normalized = await timed('normalize', () => call('normalize', { context, mappings: { bank: mapping('DD/MM/YYYY', 'balance'), books: mapping('YYYY-MM-DD', null) }, period }))
  const { matchId } = await timed('match', () => call('match', { revision: normalized.revision, rules: DEFAULT_MATCHING }))
  await call('setDecisions', { matchId, events: [] })
  const page = (offset: number, tab: 'suggested' | 'unmatched', search = '') => call('getReview', { matchId, tab, offset, limit: 50, search })
  const first = await timed('suggested, first page', () => page(0, 'suggested'))
  await timed('unmatched, first page (builds index)', () => page(0, 'unmatched'))
  await timed('search, first (builds index)', () => page(0, 'suggested', 'row 1999'))
  await timed('search, later', () => page(0, 'suggested', 'row 1998'))
  const closing = money(balance)
  const setup = { ...emptyAccounting(), period, balances: { bank: { opening: '0.00', closing, basis: 'cash' as const }, books: { opening: '0.00', closing, basis: 'cash' as const } } }
  await timed('status, first (builds totals)', () => call('accounting', { matchId, setup, basis: 'b' }))
  const item = first.items[0]
  await timed('decide', () => call('decide', { matchId, seq: 1, at: 'now', decision: { action: 'confirm', bank: item.bank.key, books: item.books.key, origin: 'suggested' } }))
  await timed('status after a decision', () => call('accounting', { matchId, setup, basis: 'b' }))
  await timed('unmatched page after a decision', () => page(0, 'unmatched'))
  await timed('outstanding export', () => call('exportOutstanding', { matchId, sessionId: 's', period, exportedAt: 'now' }))
  await timed('report (JSON)', () => call('exportReport', { matchId, format: 'json', setup, basis: 'b', session: { id: 's', revision: 1 }, generatedAt: 'now' }))
  for (const [label, ms] of Object.entries(results)) console.log(`${label.padEnd(40)} ${String(ms).padStart(6)} ms`)
}

await main()
