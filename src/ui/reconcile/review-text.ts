import { CLASSIFICATION_LABELS, type DecisionEvent, EXCEPTION_LABELS, type PairEvent } from '../../reconciliation/decisions'
import { count } from '../format'
import { keyLabel } from './location'

export function decisionNote(event: PairEvent): string {
  if (event.origin === 'set') return 'Confirmed as part of an identical set; the pairing within the set is arbitrary'
  if (event.origin !== 'manual') return 'Confirmed from a suggestion'
  const broken = (event.exceptions ?? []).map((e) => EXCEPTION_LABELS[e])
  return `Manual pair${broken.length > 0 ? `: ${broken.join(', ')}` : ''}${event.reason ? ` — “${event.reason}”` : ''}`
}

export function eventText(event: DecisionEvent): string {
  const when = new Date(event.at).toLocaleString()
  if (event.action === 'complete') return `${count(event.seq)}. Marked complete · ${when}`
  if (event.action === 'classify') {
    const what = event.classification === null ? 'Cleared the classification of' : `Classified as “${CLASSIFICATION_LABELS[event.classification]}”:`
    return `${count(event.seq)}. ${what} ${keyLabel(event.key)}${event.note ? ` — “${event.note}”` : ''} · ${when}`
  }
  const verb = { confirm: 'Confirmed', reject: 'Rejected', restore: 'Restored', unmatch: 'Unmatched' }[event.action]
  const note = event.action === 'confirm' ? ` · ${decisionNote(event)}` : ''
  return `${count(event.seq)}. ${verb} ${keyLabel(event.bank)} ↔ ${keyLabel(event.books)}${note} · ${when}`
}
