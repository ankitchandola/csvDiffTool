// Runs writes one at a time, and while one is running keeps only the newest request: a
// whole-session save can take seconds for a large session, and only the latest matters.
// A write never overlaps another, and the newest request is always written last.
export function createLatestWriter<T>(write: (value: T) => Promise<void>) {
  let next: { value: T } | null = null
  let running: Promise<void> | null = null

  async function drain() {
    try {
      while (next) {
        const { value } = next
        next = null
        await write(value)
      }
    } finally {
      // A failed write rejects this run; the next request starts a fresh one.
      running = null
    }
  }

  return {
    request(value: T): Promise<void> {
      next = { value }
      running ??= drain()
      return running
    },
  }
}
