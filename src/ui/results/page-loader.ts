export const PAGE_SIZE = 200
// The worker keeps the full result; the UI holds only pages near the visible range, so a
// long scroll never copies a whole tab into the page. Evicted pages are fetched again.
export const MAX_CACHED_PAGES = 10

export interface Page<T> {
  total: number
  items: T[]
}

export interface PageLoader<T> {
  readonly total: number | null
  readonly error: string | null
  get(index: number): T | undefined
  // Loads every page that covers indices first..last; already loaded or in-flight pages are skipped.
  ensure(first: number, last: number): void
  // Marks every loaded page out of date. Rows stay readable until their fresh page arrives,
  // so a list that refetches after a change never collapses and moves the page under the reader.
  invalidate(): void
}

export function createPageLoader<T>(
  fetchPage: (offset: number, limit: number) => Promise<Page<T>>,
  onChange: () => void,
): PageLoader<T> {
  const pages = new Map<number, T[]>()
  const inFlight = new Set<number>()
  let stale = new Map<number, T[]>()
  let generation = 0
  let total: number | null = null
  let error: string | null = null
  let visibleFrom = 0
  let visibleTo = 0

  function distance(page: number) {
    return page < visibleFrom ? visibleFrom - page : page > visibleTo ? page - visibleTo : 0
  }

  function evict() {
    if (pages.size <= MAX_CACHED_PAGES) return
    const farthestFirst = [...pages.keys()].sort((a, b) => distance(b) - distance(a))
    for (const page of farthestFirst.slice(0, pages.size - MAX_CACHED_PAGES)) pages.delete(page)
  }

  function load(page: number) {
    if (pages.has(page) || inFlight.has(page)) return
    inFlight.add(page)
    const started = generation
    fetchPage(page * PAGE_SIZE, PAGE_SIZE)
      .then((result) => {
        if (started !== generation) return
        pages.set(page, result.items)
        stale.delete(page)
        total = result.total
        evict()
      })
      .catch((e: unknown) => {
        if (started === generation) error = e instanceof Error ? e.message : String(e)
      })
      .finally(() => {
        if (started !== generation) return
        inFlight.delete(page)
        onChange()
      })
  }

  return {
    get total() {
      return total
    },
    get error() {
      return error
    },
    get(index) {
      const page = Math.floor(index / PAGE_SIZE)
      return (pages.get(page) ?? stale.get(page))?.[index % PAGE_SIZE]
    },
    invalidate() {
      generation++
      for (const [page, items] of pages) stale.set(page, items)
      pages.clear()
      inFlight.clear()
    },
    ensure(first, last) {
      if (error !== null) return
      const from = Math.max(0, Math.floor(first / PAGE_SIZE))
      const to = Math.floor(Math.max(first, last) / PAGE_SIZE)
      visibleFrom = from
      visibleTo = to
      for (let page = from; page <= to; page++) load(page)
    },
  }
}
