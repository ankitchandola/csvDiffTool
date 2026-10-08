import {
  type AmbiguousKey,
  type EmptyKeyRecord,
  type KeyedRecord,
  type KeyRules,
  PROGRESS_EVERY,
  type ProgressFn,
  type Row,
  type Side,
} from './types'

export interface MatchedPair {
  encoded: string
  oldIndex: number
  newIndex: number
}

export interface KeyClassification {
  added: number[]
  removed: number[]
  matched: MatchedPair[]
  ambiguous: AmbiguousKey[]
  emptyKey: EmptyKeyRecord[]
}

interface KeyIndex {
  byKey: Map<string, number[]>
  emptyKey: number[]
}

export function normalizeKeyPart(value: string, rules: KeyRules): string {
  const trimmed = rules.trim ? value.trim() : value
  return rules.caseInsensitive ? trimmed.toLowerCase() : trimmed
}

// Strict for v1: every component is required. Isolated so optional
// components (e.g. an empty `variant`) can become a rule later.
export function isKeyComplete(normalizedParts: string[]): boolean {
  return normalizedParts.every((part) => part !== '')
}

export function encodeKey(normalizedParts: string[]): string {
  return JSON.stringify(normalizedParts)
}

export function keyParts(row: Row, rules: KeyRules): string[] {
  return rules.columns.map((column) => row[column])
}

function buildIndex(rows: Row[], rules: KeyRules, onRow: (index: number) => void): KeyIndex {
  const byKey = new Map<string, number[]>()
  const emptyKey: number[] = []
  rows.forEach((row, index) => {
    onRow(index)
    const normalized = keyParts(row, rules).map((part) => normalizeKeyPart(part, rules))
    if (!isKeyComplete(normalized)) {
      emptyKey.push(index)
      return
    }
    const encoded = encodeKey(normalized)
    const existing = byKey.get(encoded)
    if (existing) existing.push(index)
    else byKey.set(encoded, [index])
  })
  return { byKey, emptyKey }
}

function keyed(rows: Row[], indices: number[], rules: KeyRules): KeyedRecord[] {
  return indices.map((index) => ({ recordNumber: index + 1, parts: keyParts(rows[index], rules) }))
}

function emptyKeyRecords(side: Side, rows: Row[], indices: number[], rules: KeyRules): EmptyKeyRecord[] {
  return keyed(rows, indices, rules).map((record) => ({ ...record, side }))
}

export function classifyKeys(
  oldRows: Row[],
  newRows: Row[],
  rules: KeyRules,
  onProgress?: ProgressFn,
): KeyClassification {
  const total = oldRows.length + newRows.length
  const report = (done: number) => {
    if (onProgress && done % PROGRESS_EVERY === 0) onProgress('index', done, total)
  }
  const oldIndex = buildIndex(oldRows, rules, report)
  const newIndex = buildIndex(newRows, rules, (i) => report(oldRows.length + i))
  onProgress?.('index', total, total)
  const result: KeyClassification = {
    added: [],
    removed: [],
    matched: [],
    ambiguous: [],
    emptyKey: [
      ...emptyKeyRecords('old', oldRows, oldIndex.emptyKey, rules),
      ...emptyKeyRecords('new', newRows, newIndex.emptyKey, rules),
    ],
  }

  // A key duplicated on either side is excluded from both; dropping only one
  // side would report a false addition or removal.
  for (const [encoded, oldHits] of oldIndex.byKey) {
    const newHits = newIndex.byKey.get(encoded) ?? []
    if (oldHits.length > 1 || newHits.length > 1) {
      result.ambiguous.push({
        encoded,
        old: keyed(oldRows, oldHits, rules),
        new: keyed(newRows, newHits, rules),
      })
    } else if (newHits.length === 1) {
      result.matched.push({ encoded, oldIndex: oldHits[0], newIndex: newHits[0] })
    } else {
      result.removed.push(oldHits[0])
    }
  }
  for (const [encoded, newHits] of newIndex.byKey) {
    if (oldIndex.byKey.has(encoded)) continue
    if (newHits.length > 1) {
      result.ambiguous.push({ encoded, old: [], new: keyed(newRows, newHits, rules) })
    } else {
      result.added.push(newHits[0])
    }
  }
  return result
}
