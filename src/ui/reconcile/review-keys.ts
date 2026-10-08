import type { KeyboardEvent } from 'react'

const IGNORE_KEYS_IN = 'input, textarea, [role="combobox"], [role="tab"]'

// J/K or the arrow keys move between rows; C confirms, X rejects, O classifies an
// unmatched row the usual way, and Enter opens the details of the focused row.
export function reviewKeys(event: KeyboardEvent<HTMLElement>) {
  const target = event.target as HTMLElement
  if (target.closest(IGNORE_KEYS_IN) || event.altKey || event.ctrlKey || event.metaKey) return
  const row = target.closest<HTMLElement>('[data-row]')
  const key = event.key.toLowerCase()
  if (key === 'j' || key === 'arrowdown' || key === 'k' || key === 'arrowup') {
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-row]')]
    if (rows.length === 0) return
    const index = row ? rows.indexOf(row) : -1
    const next = key === 'j' || key === 'arrowdown' ? rows[index + 1] : rows[index - 1]
    if (!next && row) return
    event.preventDefault()
    const destination = next ?? rows[0]
    destination.focus()
    destination.scrollIntoView({ block: 'nearest' })
    return
  }
  if (!row || target !== row) return
  const action = key === 'c' ? 'confirm' : key === 'x' ? 'reject' : key === 'o' ? 'classify' : key === 'enter' ? 'inspect' : null
  if (!action) return
  const button = row.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)
  if (!button || button.disabled) return
  event.preventDefault()
  button.click()
}
