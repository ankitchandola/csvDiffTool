// The app tsconfig uses the DOM lib, whose `self` is a Window; type just what a worker needs.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number }>) => void) | null
  onmessageerror: (() => void) | null
  postMessage(message: unknown): void
}

const PROGRESS_INTERVAL_MS = 100

export type Reporter<Phase extends string> = (phase: Phase, done: number, total: number) => void

// Answers each request with its result or error, and forwards throttled progress; a phase
// change or a finished phase is always sent.
export function serve<Request extends { id: number }, Phase extends string>(
  handle: (request: Request, onProgress: Reporter<Phase>) => Promise<unknown>,
  name: string,
) {
  scope.onmessage = async (event) => {
    const { id } = event.data
    let lastPost = 0
    let lastPhase: Phase | null = null
    const onProgress: Reporter<Phase> = (phase, done, total) => {
      const now = performance.now()
      if (phase === lastPhase && done < total && now - lastPost < PROGRESS_INTERVAL_MS) return
      lastPost = now
      lastPhase = phase
      scope.postMessage({ id, progress: { phase, done, total } })
    }
    try {
      scope.postMessage({ id, ok: true, result: await handle(event.data as Request, onProgress) })
    } catch (error) {
      scope.postMessage({ id, ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  }
  scope.onmessageerror = () => {
    scope.postMessage({ id: null, ok: false, message: `The ${name} could not read a request` })
  }
}
