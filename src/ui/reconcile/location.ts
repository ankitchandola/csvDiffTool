import type { FileFormat } from '../../engine/types'
import type { ReconSide } from '../../reconciliation/types'
import type { Location } from '../../worker/reconcile-protocol'
import { count } from '../format'

export const SIDE_LABELS: Record<ReconSide, string> = { bank: 'Bank', books: 'Books' }

export type Formats = Record<ReconSide, FileFormat | undefined>

export function locationText({ side, recordNumber, span }: Location, formats: Formats): string {
  const base = `${SIDE_LABELS[side]} record ${count(recordNumber)}`
  if (!span) return base
  if (formats[side]?.kind === 'xlsx') return `${base} · row ${count(span.first)}`
  return `${base} · ${span.first === span.last ? `line ${count(span.first)}` : `lines ${count(span.first)}–${count(span.last)}`}`
}
