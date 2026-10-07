import type { FileFormat } from '../../engine/types'
import type { ReconSide } from '../../reconciliation/types'
import type { Location } from '../../worker/reconcile-protocol'
import { parseTxnKey } from '../../reconciliation/decisions'
import type { OriginalValues } from '../../worker/reconcile-protocol'
import { count, formatValue } from '../format'

export const SIDE_LABELS: Record<ReconSide, string> = { bank: 'Bank', books: 'Books' }

export type Formats = Record<ReconSide, FileFormat | undefined>

export function locationText({ side, recordNumber, span }: Location, formats: Formats): string {
  const base = `${SIDE_LABELS[side]} record ${count(recordNumber)}`
  if (!span) return base
  if (formats[side]?.kind === 'xlsx') return `${base} · row ${count(span.first)}`
  return `${base} · ${span.first === span.last ? `line ${count(span.first)}` : `lines ${count(span.first)}–${count(span.last)}`}`
}

export function originalAmount(original: OriginalValues): string {
  return original.amount.length === 1 ? formatValue(original.amount[0]) : `in ${formatValue(original.amount[0])} · out ${formatValue(original.amount[1])}`
}

export function keyLabel(key: string): string {
  const parsed = parseTxnKey(key)
  return parsed ? `${SIDE_LABELS[parsed.side]} record ${count(parsed.recordNumber)}` : key
}
