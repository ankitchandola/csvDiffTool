export function count(n: number): string {
  return n.toLocaleString('en-US')
}

export const RECORD_NUMBER_NOTE = 'Record numbers count data records only: the header and skipped blank lines are not counted.'

// Key parts as typed, quoting only values whose edges or emptiness would otherwise be invisible.
export function formatKey(parts: string[]): string {
  return parts.map((p) => (p === '' || p.trim() !== p ? JSON.stringify(p) : p)).join(' · ')
}
