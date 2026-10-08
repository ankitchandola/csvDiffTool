import { MAX_PAGE_SIZE, type Preview } from './protocol'

// The worker keeps complete lists; the UI gets the first items and the total.
export function preview<T>(items: T[], size: number): Preview<T> {
  return { items: items.slice(0, size), total: items.length }
}

// A requested page clamped to whole numbers and to the largest page size.
export function pageBounds(offset: number, limit: number): [number, number] {
  const start = Math.max(0, Math.floor(offset))
  return [start, start + Math.min(MAX_PAGE_SIZE, Math.max(0, Math.floor(limit)))]
}
