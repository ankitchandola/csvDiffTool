import type { MatchingRules, Transaction } from './types'

// Tier numbers follow the spec's precedence. With amount tolerance fixed at zero, tiers 2
// and 4 (amount within tolerance) cannot occur.
export type Tier = 1 | 3

// bank and books are positions in each side's transaction list.
export interface Candidate {
  bank: number
  books: number
  tier: Tier
  // Bank date minus books date, in days.
  gap: number
  group: number
}

// Transactions connected through candidates, on both sides. Competition anywhere in the
// group means no pair in it is unique.
export interface ConflictGroup {
  id: number
  bank: number[]
  books: number[]
  pairs: number
  unique: boolean
}

export interface MatchOutcome {
  candidates: Candidate[]
  groups: ConflictGroup[]
  noCandidate: { bank: number[]; books: number[] }
  // Pairs that met amount and date rules but whose shared-identifier references differ.
  referenceConflicts: number
  // Set when the candidate budget ran out: the search is incomplete, not a finding of no match.
  incomplete: string | null
}

// At this budget, finding suggestions took about one second in Chrome on an Apple M4
// (docs/benchmarks.md#reconcile-in-the-browser); lower-memory devices are unmeasured.
export const MAX_CANDIDATES = 2_000_000

function byContent(a: Transaction, b: Transaction): number {
  if (a.day !== b.day) return a.day - b.day
  if (a.amount.units !== b.amount.units) return a.amount.units < b.amount.units ? -1 : 1
  const ra = a.reference ?? ''
  const rb = b.reference ?? ''
  if (ra !== rb) return ra < rb ? -1 : 1
  return a.index - b.index
}

function find(parent: Int32Array, node: number): number {
  let root = node
  while (parent[root] !== root) root = parent[root]
  while (parent[node] !== root) {
    const next = parent[node]
    parent[node] = root
    node = next
  }
  return root
}

// Amounts share the currency's scale, so equal units mean equal signed cash flows; the
// sign is part of the key, so money in never pairs with money out.
export function findCandidates(
  bank: Transaction[],
  books: Transaction[],
  rules: MatchingRules,
  maxCandidates: number = MAX_CANDIDATES,
): MatchOutcome {
  // Two carried opening items never clear each other: each clears only against a
  // transaction from the current period.
  const reference = (t: Transaction) => (t.reference === null ? null : rules.referenceCaseInsensitive ? t.reference.toLowerCase() : t.reference)
  const buckets = new Map<bigint, number[]>()
  books.forEach((t, position) => {
    const bucket = buckets.get(t.amount.units)
    if (bucket) bucket.push(position)
    else buckets.set(t.amount.units, [position])
  })
  for (const bucket of buckets.values()) bucket.sort((a, b) => byContent(books[a], books[b]))

  const pairs: Omit<Candidate, 'group'>[] = []
  let referenceConflicts = 0
  let incomplete: string | null = null
  // Content order, so which pairs a budget cut leaves out does not depend on file order.
  const bankOrder = bank.map((_, position) => position).sort((a, b) => byContent(bank[a], bank[b]))
  search: for (const b of bankOrder) {
    const t = bank[b]
    const bucket = buckets.get(t.amount.units)
    if (!bucket) continue
    const earliest = t.day - rules.bankDaysAfter
    const latest = t.day + rules.bankDaysBefore
    let low = 0
    let high = bucket.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (books[bucket[mid]].day < earliest) low = mid + 1
      else high = mid
    }
    for (let i = low; i < bucket.length && books[bucket[i]].day <= latest; i++) {
      const position = bucket[i]
      const other = books[position]
      if (t.opening && other.opening) continue
      let tier: Tier = 3
      if (rules.referencesShared) {
        const ours = reference(t)
        const theirs = reference(other)
        if (ours !== null && theirs !== null) {
          if (ours !== theirs) {
            referenceConflicts++
            continue
          }
          tier = 1
        }
      }
      if (pairs.length >= maxCandidates) {
        incomplete = `The search stopped after ${maxCandidates.toLocaleString('en-US')} candidate pairs. Narrow the date window or split the period.`
        break search
      }
      pairs.push({ bank: b, books: position, tier, gap: t.day - other.day })
    }
  }

  const parent = new Int32Array(bank.length + books.length).map((_, i) => i)
  for (const pair of pairs) {
    const a = find(parent, pair.bank)
    const c = find(parent, bank.length + pair.books)
    if (a !== c) parent[a] = c
  }

  const members = new Map<number, { bank: number[]; books: number[]; pairs: number }>()
  const memberOf = (root: number) => {
    let entry = members.get(root)
    if (!entry) {
      entry = { bank: [], books: [], pairs: 0 }
      members.set(root, entry)
    }
    return entry
  }
  const bankLinked = new Uint8Array(bank.length)
  const booksLinked = new Uint8Array(books.length)
  for (const pair of pairs) {
    memberOf(find(parent, pair.bank)).pairs++
    if (!bankLinked[pair.bank]) {
      bankLinked[pair.bank] = 1
      memberOf(find(parent, pair.bank)).bank.push(pair.bank)
    }
    if (!booksLinked[pair.books]) {
      booksLinked[pair.books] = 1
      memberOf(find(parent, bank.length + pair.books)).books.push(pair.books)
    }
  }

  const ordered = [...members.entries()]
  for (const [, entry] of ordered) {
    entry.bank.sort((a, b) => byContent(bank[a], bank[b]))
    entry.books.sort((a, b) => byContent(books[a], books[b]))
  }
  ordered.sort(([, x], [, y]) => byContent(bank[x.bank[0]], bank[y.bank[0]]))
  const groupOfRoot = new Map<number, number>()
  const groups: ConflictGroup[] = ordered.map(([root, entry], id) => {
    groupOfRoot.set(root, id)
    return { id, ...entry, unique: entry.pairs === 1 }
  })

  const candidates: Candidate[] = pairs.map((pair) => ({ ...pair, group: groupOfRoot.get(find(parent, pair.bank)) as number }))
  candidates.sort(
    (x, y) =>
      x.group - y.group ||
      x.tier - y.tier ||
      Math.abs(x.gap) - Math.abs(y.gap) ||
      byContent(bank[x.bank], bank[y.bank]) ||
      byContent(books[x.books], books[y.books]),
  )

  return {
    candidates,
    groups,
    noCandidate: {
      bank: bank.map((_, i) => i).filter((i) => !bankLinked[i]),
      books: books.map((_, i) => i).filter((i) => !booksLinked[i]),
    },
    referenceConflicts,
    incomplete,
  }
}
