import { DEFAULT_LAYOUT, type Layout } from '../../engine/parse'
import type { Delimiter } from '../../engine/types'
import type { DateFormat } from '../../reconciliation/dates'
import { mappingIssues } from '../../reconciliation/normalize'
import type { DateKind, Direction, SideMapping } from '../../reconciliation/types'

// Form state for one side. Both amount layouts keep their column choices, so switching
// between them loses nothing. Empty strings mean "not chosen".
export interface MappingDraft {
  delimiter: 'auto' | Delimiter
  layout: Layout
  dateColumn: string
  dateFormat: DateFormat | ''
  dateKind: DateKind
  amountKind: 'signed' | 'split'
  amountColumn: string
  positiveIs: Direction
  inColumn: string
  outColumn: string
  unused: 'blank' | 'blank-or-zero'
  grouped: boolean
  trailingMinus: boolean
  parentheses: boolean
  reference: string
  description: string
}

export function emptyDraft(): MappingDraft {
  return {
    delimiter: 'auto',
    layout: DEFAULT_LAYOUT,
    dateColumn: '',
    dateFormat: '',
    dateKind: 'posting',
    amountKind: 'signed',
    amountColumn: '',
    positiveIs: 'in',
    inColumn: '',
    outColumn: '',
    unused: 'blank',
    grouped: false,
    trailingMinus: false,
    parentheses: false,
    reference: '',
    description: '',
  }
}

export type DraftOutcome = { ok: true; mapping: SideMapping } | { ok: false; issues: string[] }

export function toMapping(draft: MappingDraft, headers: string[]): DraftOutcome {
  const mapping: SideMapping = {
    delimiter: draft.delimiter,
    layout: draft.layout,
    date: { column: draft.dateColumn, format: draft.dateFormat || 'YYYY-MM-DD', kind: draft.dateKind },
    amount:
      draft.amountKind === 'signed'
        ? { kind: 'signed', column: draft.amountColumn, positiveIs: draft.positiveIs }
        : { kind: 'split', inColumn: draft.inColumn, outColumn: draft.outColumn, unused: draft.unused },
    amountFormat: { grouped: draft.grouped, trailingMinus: draft.trailingMinus, parentheses: draft.parentheses },
    reference: draft.reference || null,
    description: draft.description || null,
  }
  const issues = mappingIssues(mapping, headers)
  if (draft.dateFormat === '') issues.push('Choose the date format')
  return issues.length > 0 ? { ok: false, issues } : { ok: true, mapping }
}
