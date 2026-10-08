import { useCallback, useRef, useState } from 'react'
import type { Activity, TaskProgress } from './activity'

// Only the latest run of a task may update or clear its progress. A task appears with its
// first progress message; user-started tasks call show() to appear before that.
export function useActivity<T extends string, P extends string>() {
  const [activity, setActivity] = useState<Activity<T, P>>({})
  const tokens = useRef<Partial<Record<T, number>>>({})

  const track = useCallback((task: T) => {
    const token = (tokens.current[task] ?? 0) + 1
    tokens.current[task] = token
    const live = () => tokens.current[task] === token
    return {
      show: () => {
        if (live()) setActivity((a) => ({ ...a, [task]: a[task] ?? null }))
      },
      progress: (p: TaskProgress<P>) => {
        if (live()) setActivity((a) => ({ ...a, [task]: p }))
      },
      end: () => {
        if (!live()) return
        setActivity((a) => {
          const next = { ...a }
          delete next[task]
          return next
        })
      },
    }
  }, [])

  function clear() {
    tokens.current = {}
    setActivity({})
  }

  return { activity, track, clear }
}
