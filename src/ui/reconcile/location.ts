import type { FileFormat } from '../../engine/types'
import type { ReconSide } from '../../reconciliation/types'
import type { Location } from '../../worker/reconcile-protocol'
import { parseTxnKey } from '../../reconciliation/decisions'
import { placeLabel, SIDE_LABELS } from '../../reconciliation/location'
import type { OriginalValues } from '../../worker/reconcile-protocol'
import { count, formatValue } from '../format'

export { SIDE_LABELS }

export type Formats = Record<ReconSide, FileFormat | undefined>

export const SOURCE_TITLES: Record<ReconSide, { title: string; badge: string; caption: string }> = {
  bank: { title: 'Bank statement', badge: 'B', caption: 'From the bank' },
  books: { title: 'Books', badge: 'L', caption: 'Your ledger' },
}

export function locationText(location: Location, formats: Formats): string {
  return placeLabel(location, formats[location.side]?.kind)
}

export function originalAmount(original: OriginalValues): string {
  return original.amount.length === 1 ? formatValue(original.amount[0]) : `in ${formatValue(original.amount[0])} · out ${formatValue(original.amount[1])}`
}

export function keyLabel(key: string): string {
  const parsed = parseTxnKey(key)
  return parsed ? `${SIDE_LABELS[parsed.side]} record ${count(parsed.recordNumber)}` : key
}
