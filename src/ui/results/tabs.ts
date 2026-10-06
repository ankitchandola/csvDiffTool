export type Tab = 'added' | 'removed' | 'changed' | 'problems'

// Opens on the first tab with something in it, so a result with only additions doesn't
// open on an empty Changed tab.
export function firstRelevantTab(counts: { added: number; removed: number; changed: number }, problems: number): Tab {
  if (counts.changed > 0) return 'changed'
  if (counts.added > 0) return 'added'
  if (counts.removed > 0) return 'removed'
  return problems > 0 ? 'problems' : 'changed'
}
