import { count } from './format'

export function ShowingNote({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null
  return (
    <p>
      Showing {count(shown)} of {count(total)}.
    </p>
  )
}
