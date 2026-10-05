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
}

export function createPageLoader<T>(
  fetchPage: (offset: number, limit: number) => Promise<Page<T>>,
  onChange: () => void,
): PageLoader<T> {
  const pages = new Map<number, T[]>()
  const inFlight = new Set<number>()
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
    fetchPage(page * PAGE_SIZE, PAGE_SIZE)
      .then((result) => {
        pages.set(page, result.items)
        total = result.total
        evict()
      })
      .catch((e: unknown) => {
        error = e instanceof Error ? e.message : String(e)
      })
      .finally(() => {
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
      return pages.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE]
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
