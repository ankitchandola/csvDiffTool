import type { Requests, RequestType, Results, WorkerRequest, WorkerResponse } from './protocol'

export interface CompareClient {
  call<K extends RequestType>(type: K, payload: Requests[K]): Promise<Results[K]>
  terminate(): void
}

type Pending = { resolve: (value: never) => void; reject: (error: Error) => void }

// onFailure fires when the worker dies. Its state (the parsed files) is gone with it;
// the next call starts a fresh worker, so callers must load the files again.
export function createCompareClient(onFailure: (message: string) => void): CompareClient {
  const pending = new Map<number, Pending>()
  let worker: Worker | null = null
  let nextId = 1

  function stop(error: Error) {
    worker?.terminate()
    worker = null
    for (const { reject } of pending.values()) reject(error)
    pending.clear()
  }

  function fail(message: string) {
    stop(new Error(message))
    onFailure(message)
  }

  function start(): Worker {
    const w = new Worker(new URL('./compare.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data
      if (response.id === null) {
        if (!response.ok) fail(response.message)
        return
      }
      const entry = pending.get(response.id)
      if (!entry) return
      pending.delete(response.id)
      if (response.ok) entry.resolve(response.result as never)
      else entry.reject(new Error(response.message))
    }
    w.onerror = (event) => {
      event.preventDefault()
      fail(event.message || 'The comparison worker stopped unexpectedly')
    }
    w.onmessageerror = () => fail('A reply from the comparison worker could not be read')
    return w
  }

  return {
    call(type, payload) {
      const id = nextId++
      let target: Worker
      try {
        target = worker ??= start()
      } catch (error) {
        const message = `The comparison worker could not start: ${error instanceof Error ? error.message : String(error)}`
        fail(message)
        return Promise.reject(new Error(message))
      }
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: never) => void, reject })
        try {
          target.postMessage({ id, type, ...payload } as WorkerRequest)
        } catch (error) {
          pending.delete(id)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    terminate() {
      stop(new Error('Worker terminated'))
    },
  }
}
