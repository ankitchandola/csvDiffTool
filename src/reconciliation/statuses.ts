import { type Bridge, sourceGap } from './accounting'
import { RECON_SIDES } from './types'

export interface ReviewFacts {
  // Remaining unmatched movements and opening items the reviewer has not classified.
  unclassified: number
  // Rows that can't take part: invalid dates or amounts.
  problems: number
  // Further reasons a side's source can't be validated, such as a running-balance break.
  sourceIssues: string[]
  // Confirmed matches whose amounts differ, without a reason recorded.
  unexplainedVariances: number
  // marked: a mark-complete is in the history. current: it is the latest decision and was
  // made for the files, mappings, rules and balances in use now.
  completion: { marked: boolean; current: boolean }
}

export interface Status {
  earned: boolean
  // Why it is not earned, in plain words; empty when earned.
  reasons: string[]
}

export interface Statuses {
  sourcesValidated: Status
  bridgeComplete: Status
  outstandingReviewed: Status
  completed: Status
  // Everything except the reviewer's own mark is in place.
  canMarkComplete: boolean
  // Why it can't be marked complete yet, in plain words; empty when it can.
  notReady: string[]
}

function status(reasons: string[]): Status {
  return { earned: reasons.length === 0, reasons }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

// The bridge is an identity once everything is classified as matched or unmatched, so it
// balances whether or not anyone reviewed anything. Completion therefore also needs every
// outstanding item classified, no problems, explained variances and the reviewer's mark.
export function computeStatuses(bridge: Bridge, facts: ReviewFacts): Statuses {
  const sourceReasons = [...RECON_SIDES.map((side) => sourceGap(side, bridge.source[side])).filter((gap) => gap !== null), ...facts.sourceIssues]
  const sourcesValidated = status(sourceReasons)
  const bridgeComplete = status(bridge.complete ? [] : bridge.gaps.length > 0 ? bridge.gaps : ['The bridge is not computed yet'])
  const outstandingReviewed = status(facts.unclassified > 0 ? [`${plural(facts.unclassified, 'unmatched item is', 'unmatched items are')} not classified`] : [])
  const blockers = [
    ...(facts.problems > 0 ? [`${plural(facts.problems, 'row has a problem', 'rows have problems')}`] : []),
    ...(facts.unexplainedVariances > 0 ? [`${plural(facts.unexplainedVariances, 'confirmed match has', 'confirmed matches have')} an unexplained difference`] : []),
  ]
  const notReady = [...new Set([...sourcesValidated.reasons, ...bridgeComplete.reasons, ...outstandingReviewed.reasons, ...blockers])]
  const canMarkComplete = notReady.length === 0
  const completed = status([
    ...(sourcesValidated.earned ? [] : ['Source balances are not validated']),
    ...(bridgeComplete.earned ? [] : ['The balance bridge is not complete']),
    ...(outstandingReviewed.earned ? [] : ['Outstanding items are not all reviewed']),
    ...blockers,
    ...(!facts.completion.marked
      ? ['Not marked complete']
      : !facts.completion.current
        ? ['Marked complete earlier, but decisions or the setup changed since']
        : []),
  ])
  return { sourcesValidated, bridgeComplete, outstandingReviewed, completed, canMarkComplete, notReady }
}

// A short, stable fingerprint of the setup a completion was made for (files, mappings,
// rules, balances, opening items). Change detection only, not security: FNV-1a, 64-bit.
export function setupFingerprint(setup: unknown): string {
  const text = JSON.stringify(setup)
  let hash = 0xcbf29ce484222325n
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i))
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}
