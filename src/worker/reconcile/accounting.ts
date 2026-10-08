import { type Decimal, formatDecimal, parseDecimal, subtractDecimal, toScale } from '../../engine/decimal'
import { type BalanceBasis, cashBalance, checkRunningBalance, computeBridge, type RunningBalanceCheck, sum } from '../../reconciliation/accounting'
import { buildOutstandingFile, type OutstandingSource } from '../../reconciliation/carryforward'
import { applyToState, type DecisionEvent } from '../../reconciliation/decisions'
import { type AccountingSetup } from '../../reconciliation/session'
import { computeStatuses, type ReviewFacts } from '../../reconciliation/statuses'
import { RECON_SIDES, type ReconSide, type Transaction } from '../../reconciliation/types'
import { type AccountingReport, type ReconRequests, type ReconResults } from '../reconcile-protocol'
import { currentReview, expectNextSeq, descriptionOf, keyOf, type Normalized, openingItem, resolve, type ReviewState, type Run, type Source, type Workspace } from './workspace'

// Balances, the bridge, statuses, completion and the outstanding-items export.

// Balance text as typed, in cash terms; errors name what could not be read.
export function statedBalances(setup: AccountingSetup, minorUnits: number) {
  const errors: string[] = []
  const read = (side: ReconSide, field: 'opening' | 'closing'): Decimal | null => {
    const text = setup.balances[side][field]
    if (text === null || text.trim() === '') return null
    const value = parseDecimal(text.trim(), { grouped: true })
    const scaled = value && toScale(value, minorUnits)
    if (!scaled) {
      errors.push(`${side === 'bank' ? 'Bank' : 'Books'} ${field} balance "${text}" is not an amount with at most ${minorUnits} decimal places`)
      return null
    }
    return cashBalance(scaled, setup.balances[side].basis)
  }
  const balances = {
    bank: { opening: read('bank', 'opening'), closing: read('bank', 'closing') },
    books: { opening: read('books', 'opening'), closing: read('books', 'closing') },
  }
  return { balances, errors }
}

// Walks the side's rows in file order; a row without a valid amount stops the check.
export function runningBalance(ws: Workspace, data: Normalized, side: ReconSide, opening: Decimal | null, basis: BalanceBasis): RunningBalanceCheck | null {
  const column = data.mappings[side].balance
  if (column === null || opening === null) return null
  const { minorUnits } = data.context
  const amounts = new Map(data.sides[side].transactions.map((t) => [t.index, t.amount]))
  const zero = new Set(data.sides[side].zero)
  const rows = (ws.sources[side] as Source).file.rows.map((row, index) => {
    const amount = amounts.get(index) ?? (zero.has(index) ? { units: 0n, scale: minorUnits } : null)
    const parsed = parseDecimal(row[column].trim(), data.mappings[side].amountFormat)
    const scaled = parsed && toScale(parsed, minorUnits)
    return { amount, balance: scaled ? cashBalance(scaled, basis) : null }
  })
  return checkRunningBalance(opening, rows)
}

export function runningIssue(side: ReconSide, check: RunningBalanceCheck | null): string | null {
  const name = side === 'bank' ? 'Bank' : 'Books'
  if (check?.status === 'break') {
    return `${name}: the running balance breaks at record ${check.first.row} (expected ${formatDecimal(check.first.expected)}, found ${formatDecimal(check.first.found)})`
  }
  if (check?.status === 'unreadable') return `${name}: the running balance can't be checked past record ${check.row}`
  return null
}

export function report(ws: Workspace, run: Run, data: Normalized, state: ReviewState, setup: AccountingSetup, basis: string): AccountingReport {
  const { balances, errors } = statedBalances(setup, data.context.minorUnits)
  const amounts = (ts: Transaction[]) => ts.map((t) => t.amount)
  const unmatched = (side: ReconSide) => data.pool[side].filter((t, p) => !t.opening && !state.used[side][p])
  const openingAll = (side: ReconSide) => data.pool[side].filter((t) => t.opening)
  const openingRemaining = (side: ReconSide) => data.pool[side].filter((t, p) => t.opening && !state.used[side][p])
  const invalid = (side: ReconSide) => new Set(data.sides[side].problems.map((p) => p.index)).size
  const movement = { bank: sum(amounts(data.sides.bank.transactions)), books: sum(amounts(data.sides.books.transactions)) }
  const confirmed = [...state.replay.state.active.values()]
  const differences = confirmed.map((event) => subtractDecimal((resolve(ws, event.bank) as Transaction).amount, (resolve(ws, event.books) as Transaction).amount))
  const bridge = computeBridge({
    sides: {
      bank: { balances: balances.bank, movement: movement.bank, invalidRows: invalid('bank') },
      books: { balances: balances.books, movement: movement.books, invalidRows: invalid('books') },
    },
    openingAll: { bank: amounts(openingAll('bank')), books: amounts(openingAll('books')) },
    openingRemaining: { bank: amounts(openingRemaining('bank')), books: amounts(openingRemaining('books')) },
    unmatched: { bank: amounts(unmatched('bank')), books: amounts(unmatched('books')) },
    confirmedDifferences: differences,
    incompleteSearch: run.outcome.incomplete !== null,
  })
  const classifications = state.replay.state.classifications
  // Remaining opening items need a classification as much as unmatched movements do.
  const unclassified = RECON_SIDES.reduce((n, side) => n + [...unmatched(side), ...openingRemaining(side)].filter((t) => !classifications.has(keyOf(ws, t))).length, 0)
  const completion = state.replay.state.completion
  const running = {
    bank: runningBalance(ws, data, 'bank', balances.bank.opening, setup.balances.bank.basis),
    books: runningBalance(ws, data, 'books', balances.books.opening, setup.balances.books.basis),
  }
  const facts: ReviewFacts = {
    unclassified,
    problems: invalid('bank') + invalid('books'),
    sourceIssues: RECON_SIDES.map((side) => runningIssue(side, running[side])).filter((issue): issue is string => issue !== null),
    unexplainedVariances: confirmed.filter((event, i) => differences[i].units !== 0n && !event.reason?.trim()).length,
    completion: { marked: completion !== null, current: completion !== null && completion.seq === state.replay.state.lastSeq && completion.basis === basis },
  }
  return { bridge, statuses: computeStatuses(bridge, facts), balances, balanceErrors: errors, movement, facts, running }
}

export function exportOutstanding(ws: Workspace, { matchId, sessionId, period, exportedAt }: ReconRequests['exportOutstanding']): ReconResults['exportOutstanding'] {
  const { normalized: data, review: state } = currentReview(ws, matchId)
  const outstanding: OutstandingSource[] = []
  const cleared: string[] = []
  for (const side of RECON_SIDES) {
    data.pool[side].forEach((t, p) => {
      const carried = openingItem(ws, t)
      if (state.used[side][p]) {
        if (carried) cleared.push(carried.lineage)
        return
      }
      const source = ws.sources[side] as Source
      outstanding.push({
        transaction: t,
        description: carried ? carried.description : descriptionOf(ws, data, t) || null,
        carried,
        provenance: carried ? carried.origin : { sessionId, period, fileName: source.name, fingerprint: source.fingerprint, recordNumber: t.index + 1 },
      })
    })
  }
  // Clearances inherited from imported files travel on, so a later period can still refuse
  // a stale file that lists one of them as outstanding.
  const allCleared = [...new Set([...ws.opening.flatMap((o) => o.file.cleared), ...cleared])]
  const file = buildOutstandingFile({ sessionId, context: data.context, period, outstanding, cleared: allCleared, exportedAt })
  return { text: JSON.stringify(file, null, 2), items: file.items.length, cleared: allCleared.length }
}

export function accounting(ws: Workspace, { matchId, setup, basis }: ReconRequests['accounting']): ReconResults['accounting'] {
  const { latest: run, normalized: data, review: state } = currentReview(ws, matchId)
  return report(ws, run, data, state, setup, basis)
}

export function markComplete(ws: Workspace, { matchId, seq, at, setup, basis }: ReconRequests['markComplete']): ReconResults['markComplete'] {
  const { latest: run, normalized: data, review: state } = currentReview(ws, matchId)
  expectNextSeq(state, seq)
  const before = report(ws, run, data, state, setup, basis)
  if (!before.statuses.canMarkComplete) return { ok: false, reason: `Not ready to mark complete: ${before.statuses.notReady.join('; ')}` }
  const event: DecisionEvent = { seq, at, action: 'complete', basis }
  state.events.push(event)
  applyToState(state.replay.state, event)
  return { ok: true, event, report: report(ws, run, data, state, setup, basis) }
}
