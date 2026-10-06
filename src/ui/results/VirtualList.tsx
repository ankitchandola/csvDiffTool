import { useVirtualizer } from '@tanstack/react-virtual'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { createPageLoader, type Page } from './page-loader'

// Rows are fetched from the worker a page at a time as they scroll into view, so the
// main thread only ever holds the pages that were visible. Remount (via key) to reset.
export function VirtualList<T>({
  fetchPage,
  header,
  renderRow,
  estimateSize,
  minWidth,
  empty,
  label = 'Comparison records, scroll to browse',
  summary,
}: {
  fetchPage: (offset: number, limit: number) => Promise<Page<T>>
  header?: ReactNode
  renderRow: (item: T | undefined, index: number) => ReactNode
  estimateSize: number
  minWidth?: string
  empty: string
  label?: string
  // A line above the list once the total is known, e.g. a search's match count.
  summary?: (total: number) => ReactNode
}) {
  const [, setVersion] = useState(0)
  const [loader] = useState(() => createPageLoader(fetchPage, () => setVersion((v) => v + 1)))
  const scrollRef = useRef<HTMLDivElement>(null)
  // oxlint-disable-next-line react/incompatible-library -- React Compiler isn't enabled here; this is TanStack Virtual's documented usage.
  const virtualizer = useVirtualizer({
    count: loader.total ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan: 8,
  })
  const items = virtualizer.getVirtualItems()
  const first = items[0]?.index ?? 0
  const last = items.at(-1)?.index ?? 0

  useEffect(() => {
    loader.ensure(first, last)
  }, [loader, first, last])

  if (loader.error !== null) return <p className="error">{loader.error}</p>
  if (loader.total === null) return <p className="muted">Loading…</p>
  if (loader.total === 0) return <p className="muted">{empty}</p>

  return (
    <>
      {summary && <p className="muted" role="status">{summary(loader.total)}</p>}
      <div ref={scrollRef} className="vlist" tabIndex={0} role="region" aria-label={label}>
        <div style={{ minWidth }}>
          {header && <div className="vlist-header">{header}</div>}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {items.map((item) => (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="vlist-row"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {renderRow(loader.get(item.index), item.index)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
