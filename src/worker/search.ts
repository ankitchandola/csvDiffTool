// Case-insensitive "contains" over every text a result item shows, so a search finds what
// the user can see in the table: key parts, field values, column names and messages.
export function normaliseSearch(search: string | undefined): string {
  return (search ?? '').trim().toLowerCase()
}

export function matches(texts: Iterable<string>, needle: string): boolean {
  for (const text of texts) if (text.toLowerCase().includes(needle)) return true
  return false
}

// Keeps the latest filtered list per (result, tab, column, search), so paging through one
// search filters once rather than once per page.
export function createSearchCache() {
  let entry: { key: string; items: unknown[] } | null = null
  return {
    get<T>(key: string, build: () => T[]): T[] {
      if (entry?.key !== key) entry = { key, items: build() }
      return entry.items as T[]
    },
  }
}
