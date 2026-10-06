import { useEffect, useState } from 'react'

// The value as it stood once it stopped changing for delayMs, so typing doesn't send a
// worker request per keystroke.
export function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return settled
}
