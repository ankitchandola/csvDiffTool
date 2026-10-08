// Arrow keys wrap, Home and End jump: the ARIA tabs keyboard pattern.
export function tabKeyTarget(key: string, index: number, length: number): number | null {
  if (key === 'ArrowRight') return (index + 1) % length
  if (key === 'ArrowLeft') return (index + length - 1) % length
  if (key === 'Home') return 0
  if (key === 'End') return length - 1
  return null
}
