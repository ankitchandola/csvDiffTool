import { addDecimal } from '../engine/decimal'
import type { Row } from '../engine/types'
import type { NormalizationProblem, ReconSide, Transaction } from './types'

// One unit for several transactions on the same side, in the order given.
export function groupOf(members: Transaction[], batch?: string): Transaction {
  const [first, ...rest] = members
  return {
    side: first.side,
    index: first.index,
    day: rest.reduce((latest, m) => Math.max(latest, m.day), first.day),
    amount: rest.reduce((total, m) => addDecimal(total, m.amount), first.amount),
    reference: null,
    members,
    ...(batch !== undefined && { batch }),
  }
}

export function mixedDirections(members: Transaction[]): boolean {
  const firstIn = members[0].amount.units > 0n
  return members.some((m) => m.amount.units > 0n !== firstIn)
}

// Every transaction in the unit came from an earlier period's outstanding items.
export function allCarried(t: Transaction): boolean {
  return t.members ? t.members.every((m) => m.opening !== undefined) : t.opening !== undefined
}

// Rows sharing a batch ID become one group. A batch with an invalid record, or with money
// both in and out, is not matched at all: a smaller or netted sum would hide a difference.
export function batchUnits(side: ReconSide, rows: Row[], column: string, transactions: Transaction[], problems: NormalizationProblem[]): Transaction[] {
  const batchOf = (index: number) => rows[index][column].trim()
  const invalid = new Set(problems.map((p) => batchOf(p.index)))
  const batches = new Map<string, Transaction[]>()
  const units: Transaction[] = []
  for (const t of transactions) {
    const id = batchOf(t.index)
    const members = id === '' ? undefined : batches.get(id)
    if (id === '') units.push(t)
    else if (members) members.push(t)
    else batches.set(id, [t])
  }
  for (const [id, members] of batches) {
    const reason = invalid.has(id)
      ? `Batch “${id}” has an invalid record, so none of the batch is matched`
      : mixedDirections(members)
        ? `Batch “${id}” has money in and money out; matching its net amount isn’t supported`
        : null
    if (reason === null) units.push(members.length === 1 ? members[0] : groupOf(members, id))
    else for (const m of members) problems.push({ side, index: m.index, field: 'batch', message: reason })
  }
  return units.sort((a, b) => a.index - b.index)
}
