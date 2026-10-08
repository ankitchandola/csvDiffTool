import type { Span } from '../engine/types'
import type { Period } from './carryforward'
import type { ReconSide } from './types'

export const SIDE_LABELS: Record<ReconSide, string> = { bank: 'Bank', books: 'Books' }

export interface Place {
  side: ReconSide
  recordNumber: number
  span: Span | null
  carried?: { fileName: string; period: Period }
}

const n = (value: number) => value.toLocaleString('en-US')

// "Bank record 3 · line 5", "Books record 2 · row 7", or where a carried item first
// appeared. kind is the side's file kind, which decides lines or worksheet rows.
export function placeLabel({ side, recordNumber, span, carried }: Place, kind: 'csv' | 'xlsx' | undefined): string {
  if (carried) return `Carried · ${SIDE_LABELS[side]} record ${n(recordNumber)} of ${carried.fileName} (${carried.period.start} to ${carried.period.end})`
  const base = `${SIDE_LABELS[side]} record ${n(recordNumber)}`
  if (!span) return base
  if (kind === 'xlsx') return `${base} · row ${n(span.first)}`
  return `${base} · ${span.first === span.last ? `line ${n(span.first)}` : `lines ${n(span.first)}–${n(span.last)}`}`
}
