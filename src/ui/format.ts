export function count(n: number): string {
  return n.toLocaleString('en-US')
}

export function noun(n: number, singular: string, plural = `${singular}s`): string {
  return n === 1 ? singular : plural
}

export function counted(n: number, singular: string, plural?: string): string {
  return `${count(n)} ${noun(n, singular, plural)}`
}

export const RECORD_NUMBER_NOTE = 'Record numbers count data records only: the header and skipped blank lines are not counted.'

// Key parts as typed, quoting only values whose edges or emptiness would otherwise be invisible.
export function formatKey(parts: string[]): string {
  return parts.map((p) => (p === '' || p.trim() !== p ? JSON.stringify(p) : p)).join(' · ')
}

// Field values as typed; empty values and edge spaces are quoted so they don't read as missing.
export function formatValue(value: string): string {
  return value === '' || value.trim() !== value ? JSON.stringify(value) : value
}
