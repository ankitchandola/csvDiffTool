import type { MatchingRules } from '../../reconciliation/types'
import type { SuggestionItem } from '../../worker/reconcile-protocol'
import { counted } from '../format'

function days(n: number): string {
  return counted(n, 'day')
}

export function dateEvidence(gap: number): string {
  if (gap === 0) return 'same date'
  return gap > 0 ? `bank date ${days(gap)} after books` : `bank date ${days(-gap)} before books`
}

type Evidence = Pick<SuggestionItem, 'tier' | 'gap' | 'bank' | 'books'>

function referenceEvidence(item: Evidence, rules: MatchingRules): string {
  if (!rules.referencesShared) return 'references not compared'
  if (item.tier === 1) return 'reference matched'
  const bank = item.bank.reference !== null
  const books = item.books.reference !== null
  return bank === books ? 'reference absent on both sides' : `reference absent in ${bank ? 'books' : 'bank'}`
}

export function competitionText(item: SuggestionItem): string {
  if (item.unique) return 'Only candidate for both transactions'
  return `${counted(item.groupBank, 'bank transaction')} and ${counted(item.groupBooks, 'books transaction')} compete through ${counted(item.groupPairs, 'pair')}; no unique pairing`
}

// Plain statements of the rules a pair met, not a probability.
export function evidenceText(item: Evidence, rules: MatchingRules): string {
  return `Amount exact; ${dateEvidence(item.gap)}; ${referenceEvidence(item, rules)}.`
}
