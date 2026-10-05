import type { Requests, RequestType, Results, WorkerRequest, WorkerResponse } from './protocol'

export interface CompareClient {
  call<K extends RequestType>(type: K, payload: Requests[K]): Promise<Results[K]>
  terminate(): void
}

export function createCompareClient(): CompareClient {
  const worker = new Worker(new URL('./compare.worker.ts', import.meta.url), { type: 'module' })
  const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>()
  let nextId = 1

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data
    const entry = pending.get(response.id)
    if (!entry) return
    pending.delete(response.id)
    if (response.ok) entry.resolve(response.result as never)
    else entry.reject(new Error(response.message))
  }

  return {
    call(type, payload) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: never) => void, reject })
        worker.postMessage({ id, type, ...payload } as WorkerRequest)
      })
    },
    terminate() {
      worker.terminate()
      for (const { reject } of pending.values()) reject(new Error('Worker terminated'))
      pending.clear()
    },
  }
}
