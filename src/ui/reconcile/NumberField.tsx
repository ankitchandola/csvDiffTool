import { useState } from 'react'

// Keeps the typed text while it is incomplete or out of range, and reports only valid
// whole numbers, so clearing the field to retype doesn't apply a value.
export function NumberField({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string
  value: number
  min: number
  max?: number
  onCommit: (value: number) => void
}) {
  const [text, setText] = useState(String(value))
  const [shown, setShown] = useState(value)
  if (shown !== value) {
    setShown(value)
    setText(String(value))
  }
  const parsed = /^\d+$/.test(text.trim()) ? Number(text.trim()) : null
  const invalid = parsed === null || parsed < min || (max !== undefined && parsed > max)
  return (
    <label className="field number-field">
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={text}
        aria-invalid={invalid}
        onChange={(e) => {
          setText(e.target.value)
          const next = e.target.value.trim()
          if (!/^\d+$/.test(next)) return
          const n = Number(next)
          if (n >= min && (max === undefined || n <= max) && n !== value) {
            setShown(n)
            onCommit(n)
          }
        }}
      />
    </label>
  )
}
