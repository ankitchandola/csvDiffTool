import type { Progress, Requests, Results } from './protocol'
import type { ReconProgress, ReconRequests, ReconResults } from './reconcile-protocol'

export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
  }
}

export interface WorkerClient<Q, R extends Record<keyof Q, unknown>, P> {
  call<K extends keyof Q & string>(type: K, payload: Q[K], onProgress?: (progress: P) => void): Promise<R[K]>
  // Stops the worker mid-task. Pending calls reject with CancelledError and the parsed files
  // are gone; the next call starts a fresh worker.
  cancel(): void
  terminate(): void
}

export type CompareClient = WorkerClient<Requests, Results, Progress>

type Pending<P> = {
  resolve: (value: never) => void
  reject: (error: Error) => void
  onProgress?: (progress: P) => void
}

// id null: the worker could not read a request, so it can't say which one failed.
type Response<P> =
  | { id: number; progress: P }
  | { id: number; ok: true; result: unknown }
  | { id: number | null; ok: false; message: string }

// onFailure fires when the worker dies. Its state (the parsed files) is gone with it;
// the next call starts a fresh worker, so callers must load the files again.
export function createWorkerClient<Q, R extends Record<keyof Q, unknown>, P>(
  spawn: () => Worker,
  name: string,
  onFailure: (message: string) => void,
): WorkerClient<Q, R, P> {
  const pending = new Map<number, Pending<P>>()
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
    const w = spawn()
    w.onmessage = (event: MessageEvent<Response<P>>) => {
      const response = event.data
      if ('progress' in response) {
        pending.get(response.id)?.onProgress?.(response.progress)
        return
      }
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
      fail(event.message || `The ${name} stopped unexpectedly`)
    }
    w.onmessageerror = () => fail(`A reply from the ${name} could not be read`)
    return w
  }

  return {
    call(type, payload, onProgress) {
      const id = nextId++
      let target: Worker
      try {
        target = worker ??= start()
      } catch (error) {
        const message = `The ${name} could not start: ${error instanceof Error ? error.message : String(error)}`
        fail(message)
        return Promise.reject(new Error(message))
      }
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: never) => void, reject, onProgress })
        try {
          target.postMessage({ id, type, ...payload })
        } catch (error) {
          pending.delete(id)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    cancel() {
      stop(new CancelledError())
    },
    terminate() {
      stop(new Error('Worker terminated'))
    },
  }
}

export function createCompareClient(onFailure: (message: string) => void): CompareClient {
  return createWorkerClient<Requests, Results, Progress>(
    () => new Worker(new URL('./compare.worker.ts', import.meta.url), { type: 'module' }),
    'comparison worker',
    onFailure,
  )
}

export type ReconcileClient = WorkerClient<ReconRequests, ReconResults, ReconProgress>

export function createReconcileClient(onFailure: (message: string) => void): ReconcileClient {
  return createWorkerClient<ReconRequests, ReconResults, ReconProgress>(
    () => new Worker(new URL('./reconcile.worker.ts', import.meta.url), { type: 'module' }),
    'reconciliation worker',
    onFailure,
  )
}
