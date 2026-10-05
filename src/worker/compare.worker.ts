import type { Phase } from '../engine/types'
import { createHandler } from './handler'
import type { WorkerRequest, WorkerResponse } from './protocol'

// The app tsconfig uses the DOM lib, whose `self` is a Window; type just what the worker needs.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  onmessageerror: (() => void) | null
  postMessage(message: WorkerResponse): void
}

const PROGRESS_INTERVAL_MS = 100

const handle = createHandler()

scope.onmessage = async (event) => {
  const { id } = event.data
  let lastPost = 0
  let lastPhase: Phase | null = null
  // Throttled, but a phase change or a finished phase is always sent.
  const onProgress = (phase: Phase, done: number, total: number) => {
    const now = performance.now()
    if (phase === lastPhase && done < total && now - lastPost < PROGRESS_INTERVAL_MS) return
    lastPost = now
    lastPhase = phase
    scope.postMessage({ id, progress: { phase, done, total } })
  }
  try {
    scope.postMessage({ id, ok: true, result: await handle(event.data, onProgress) })
  } catch (error) {
    scope.postMessage({ id, ok: false, message: error instanceof Error ? error.message : String(error) })
  }
}

scope.onmessageerror = () => {
  scope.postMessage({ id: null, ok: false, message: 'The comparison worker could not read a request' })
}
