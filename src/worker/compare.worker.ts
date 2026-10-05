import { createHandler } from './handler'
import type { WorkerRequest, WorkerResponse } from './protocol'

// The app tsconfig uses the DOM lib, whose `self` is a Window; type just what the worker needs.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: WorkerResponse): void
}

const handle = createHandler()

scope.onmessage = async (event) => {
  const { id } = event.data
  try {
    scope.postMessage({ id, ok: true, result: await handle(event.data) })
  } catch (error) {
    scope.postMessage({ id, ok: false, message: error instanceof Error ? error.message : String(error) })
  }
}
