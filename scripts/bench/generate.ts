export interface PairSpec {
  rows: number
  // Value columns, in addition to the id key column.
  columns: number
  fieldLength: number
  // Fractions of the old file's records.
  changeRatio: number
  addRatio: number
  removeRatio: number
  seed: number
}

export interface GeneratedPair {
  oldText: string
  newText: string
  expected: { added: number; removed: number; changed: number; unchanged: number }
}

// mulberry32: small, fast, deterministic, so a spec always produces the same files.
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

// Generates an old/new pair whose added, removed and changed counts are known exactly,
// so a benchmark run also checks the comparison is correct.
export function generatePair(spec: PairSpec): GeneratedPair {
  const next = random(spec.seed)
  const value = () => {
    let s = ''
    for (let i = 0; i < spec.fieldLength; i++) s += ALPHABET[Math.floor(next() * ALPHABET.length)]
    return s
  }
  const header = ['id', ...Array.from({ length: spec.columns }, (_, i) => `col${i + 1}`)].join(',')
  const oldLines = [header]
  const newLines = [header]
  const expected = { added: 0, removed: 0, changed: 0, unchanged: 0 }

  for (let id = 0; id < spec.rows; id++) {
    const fields = Array.from({ length: spec.columns }, value)
    oldLines.push(`${id},${fields.join(',')}`)
    const roll = next()
    if (roll < spec.removeRatio) {
      expected.removed++
    } else if (roll < spec.removeRatio + spec.changeRatio) {
      const column = Math.floor(next() * spec.columns)
      const original = fields[column]
      fields[column] = (original[0] === 'X' ? 'Y' : 'X') + original.slice(1)
      newLines.push(`${id},${fields.join(',')}`)
      expected.changed++
    } else {
      newLines.push(`${id},${fields.join(',')}`)
      expected.unchanged++
    }
  }
  const added = Math.round(spec.rows * spec.addRatio)
  for (let i = 0; i < added; i++) {
    newLines.push(`${spec.rows + i},${Array.from({ length: spec.columns }, value).join(',')}`)
    expected.added++
  }
  return { oldText: oldLines.join('\n') + '\n', newText: newLines.join('\n') + '\n', expected }
}
