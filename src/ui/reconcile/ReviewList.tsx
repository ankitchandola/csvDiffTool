import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPageLoader, type Page } from '../results/page-loader'

// The review list scrolls with the page, so there is one scrollbar. Rows are fetched a page at a
// time. When `version` changes (a decision was recorded) the rows are fetched again in place: the
// old rows stay on screen until the new ones arrive, and focus returns to the row at the same
// position, which is now the next one to review. Remount (via key) to reset the filters.
export function ReviewList<T>({
  fetchPage,
  version,
  renderRow,
  estimateSize,
  empty,
  label,
  summary,
}: {
  fetchPage: (offset: number, limit: number) => Promise<Page<T>>
  version: number
  renderRow: (item: T | undefined, index: number) => ReactNode
  estimateSize: number
  empty: string
  label: string
  summary?: (total: number) => ReactNode
}) {
  const [, setTick] = useState(0)
  const [loader] = useState(() => createPageLoader(fetchPage, () => setTick((v) => v + 1)))
  const listRef = useRef<HTMLDivElement>(null)
  const focusIndex = useRef<number | null>(null)
  const seenVersion = useRef(version)
  const [scrollMargin, setScrollMargin] = useState(0)

  useLayoutEffect(() => {
    setScrollMargin(listRef.current?.offsetTop ?? 0)
  }, [loader.total])

  // oxlint-disable-next-line react/incompatible-library -- React Compiler isn't enabled here; this is TanStack Virtual's documented usage.
  const virtualizer = useWindowVirtualizer({
    count: loader.total ?? 0,
    estimateSize: () => estimateSize,
    overscan: 6,
    scrollMargin,
  })
  const items = virtualizer.getVirtualItems()
  const first = items[0]?.index ?? 0
  const last = items.at(-1)?.index ?? 0

  if (seenVersion.current !== version) {
    seenVersion.current = version
    const row = document.activeElement?.closest<HTMLElement>('[data-index]')
    const inside = row && listRef.current?.contains(row)
    focusIndex.current = inside ? Number(row.dataset.index) : null
    loader.invalidate()
  }

  useEffect(() => {
    loader.ensure(first, last)
  })

  useEffect(() => {
    const wanted = focusIndex.current
    if (wanted === null || loader.total === null) return
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${Math.min(wanted, Math.max(loader.total - 1, 0))}"] [data-row]`)
    if (!row) return
    focusIndex.current = null
    row.focus({ preventScroll: true })
  })

  if (loader.error !== null) return <p className="error">{loader.error}</p>
  if (loader.total === null) return <p className="muted">Loading…</p>
  if (loader.total === 0) return <p className="muted review-empty">{empty}</p>

  return (
    <>
      {summary && <p className="muted" role="status">{summary(loader.total)}</p>}
      <div ref={listRef} className="review-list" role="region" aria-label={label}>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {items.map((item) => (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="vlist-row"
              style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
            >
              {renderRow(loader.get(item.index), item.index)}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
