import { describe, expect, it, vi } from 'vitest'
import { createPageLoader, PAGE_SIZE } from './page-loader'

function source(total: number) {
  const calls: number[] = []
  const fetchPage = vi.fn(async (offset: number, limit: number) => {
    calls.push(offset)
    const items = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => offset + i)
    return { total, items }
  })
  return { fetchPage, calls }
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createPageLoader', () => {
  it('loads the first page and reports the total', async () => {
    const { fetchPage } = source(450)
    const onChange = vi.fn()
    const loader = createPageLoader(fetchPage, onChange)
    expect(loader.total).toBeNull()
    loader.ensure(0, 0)
    await settle()
    expect(loader.total).toBe(450)
    expect(loader.get(199)).toBe(199)
    expect(loader.get(200)).toBeUndefined()
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('loads every page a visible range touches, once', async () => {
    const { fetchPage, calls } = source(1000)
    const loader = createPageLoader(fetchPage, () => {})
    loader.ensure(150, 450)
    loader.ensure(180, 420)
    await settle()
    expect(calls).toEqual([0, PAGE_SIZE, 2 * PAGE_SIZE])
    loader.ensure(0, 599)
    await settle()
    expect(calls).toEqual([0, PAGE_SIZE, 2 * PAGE_SIZE])
    expect(loader.get(450)).toBe(450)
  })

  it('records an error and stops requesting', async () => {
    const fetchPage = vi.fn(async () => {
      throw new Error('Compare the files first')
    })
    const loader = createPageLoader(fetchPage, () => {})
    loader.ensure(0, 0)
    await settle()
    expect(loader.error).toBe('Compare the files first')
    loader.ensure(0, 500)
    expect(fetchPage).toHaveBeenCalledOnce()
  })
})
