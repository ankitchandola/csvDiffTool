import { describe, expect, it } from 'vitest'
import { createLatestWriter } from './latest-writer'

describe('createLatestWriter', () => {
  it('writes the first request, skips the ones superseded while it runs, and writes the newest last', async () => {
    const written: number[] = []
    let active = 0
    let overlapped = false
    const writer = createLatestWriter(async (value: number) => {
      active++
      if (active > 1) overlapped = true
      await new Promise((resolve) => setTimeout(resolve, 10))
      written.push(value)
      active--
    })
    writer.request(1)
    writer.request(2)
    writer.request(3)
    await writer.request(4)
    expect(written).toEqual([1, 4])
    expect(overlapped).toBe(false)
  })

  it('keeps going after a failed write and still writes the newest', async () => {
    const written: number[] = []
    const writer = createLatestWriter(async (value: number) => {
      if (value === 1) throw new Error('quota')
      written.push(value)
    })
    await writer.request(1).catch(() => {})
    await writer.request(2)
    expect(written).toEqual([2])
  })
})
