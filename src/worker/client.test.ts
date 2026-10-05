import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCompareClient } from './client'

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null
  onmessageerror: (() => void) | null = null
  posted: { id: number }[] = []
  terminated = false

  constructor() {
    FakeWorker.instances.push(this)
  }
  postMessage(message: { id: number }) {
    this.posted.push(message)
  }
  terminate() {
    this.terminated = true
  }
  crash(message: string) {
    this.onerror?.({ message, preventDefault() {} })
  }
}

const RULES = { columns: ['id'], trim: true, caseInsensitive: false }

describe('createCompareClient', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    vi.stubGlobal('Worker', FakeWorker)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('rejects pending calls and reports the failure when the worker errors', async () => {
    const onFailure = vi.fn()
    const client = createCompareClient(onFailure)
    const call = client.call('checkKeys', { rules: RULES })
    FakeWorker.instances[0].crash('boom')
    await expect(call).rejects.toThrow('boom')
    expect(onFailure).toHaveBeenCalledWith('boom')
    expect(FakeWorker.instances[0].terminated).toBe(true)
  })

  it('treats an unreadable reply as a failure', async () => {
    const onFailure = vi.fn()
    const client = createCompareClient(onFailure)
    const call = client.call('checkKeys', { rules: RULES })
    FakeWorker.instances[0].onmessageerror?.()
    await expect(call).rejects.toThrow('could not be read')
    expect(onFailure).toHaveBeenCalledOnce()
  })

  it('fails when the worker reports a request it could not read', async () => {
    const onFailure = vi.fn()
    const client = createCompareClient(onFailure)
    const call = client.call('checkKeys', { rules: RULES })
    FakeWorker.instances[0].onmessage?.({ data: { id: null, ok: false, message: 'unreadable' } })
    await expect(call).rejects.toThrow('unreadable')
    expect(onFailure).toHaveBeenCalledWith('unreadable')
  })

  it('starts a fresh worker for the next call after a failure', async () => {
    const client = createCompareClient(() => {})
    const first = client.call('checkKeys', { rules: RULES })
    FakeWorker.instances[0].crash('boom')
    await expect(first).rejects.toThrow()

    const second = client.call('checkKeys', { rules: RULES })
    expect(FakeWorker.instances).toHaveLength(2)
    const worker = FakeWorker.instances[1]
    worker.onmessage?.({ data: { id: worker.posted[0].id, ok: true, result: 'done' } })
    await expect(second).resolves.toBe('done')
  })
})

describe('createCompareClient startup failure', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('rejects the call and reports the failure when the worker cannot be constructed', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('SecurityError')
        }
      },
    )
    const onFailure = vi.fn()
    const client = createCompareClient(onFailure)
    let call: Promise<unknown> | undefined
    expect(() => {
      call = client.call('checkKeys', { rules: RULES })
    }).not.toThrow()
    await expect(call).rejects.toThrow('could not start: SecurityError')
    expect(onFailure).toHaveBeenCalledWith('The comparison worker could not start: SecurityError')
  })
})
