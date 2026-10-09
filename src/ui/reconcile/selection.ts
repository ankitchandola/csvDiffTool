import { unitKey } from '../../reconciliation/decisions'
import type { ReconSide } from '../../reconciliation/types'
import type { UnmatchedItem } from '../../worker/reconcile-protocol'

export type Selection = Record<ReconSide, UnmatchedItem[]>

export const NO_SELECTION: Selection = { bank: [], books: [] }

export function toggle(selection: Selection, t: UnmatchedItem): Selection {
  const chosen = selection[t.side]
  const next = chosen.some((c) => c.key === t.key) ? chosen.filter((c) => c.key !== t.key) : [...chosen, t]
  return { ...selection, [t.side]: next }
}

// The unit key for one side's selection, or why it can't be one.
export function selectedUnit(chosen: UnmatchedItem[]): { key: string } | { error: string } | null {
  if (chosen.length === 0) return null
  if (chosen.length === 1) return { key: chosen[0].key }
  if (chosen.some((t) => t.group)) return { error: 'A batch is matched as a whole; it can’t join a group of other transactions' }
  return { key: unitKey(chosen.map((t) => t.key)) }
}
