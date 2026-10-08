import { useState } from 'react'

// The value of text made only of the digits 0-9, or null.
function wholeNumber(text: string): number | null {
  if (text === '') return null
  for (const ch of text) if (ch < '0' || ch > '9') return null
  return Number(text)
}

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
  const parsed = wholeNumber(text.trim())
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
          const n = wholeNumber(e.target.value.trim())
          if (n === null) return
          if (n >= min && (max === undefined || n <= max) && n !== value) {
            setShown(n)
            onCommit(n)
          }
        }}
      />
    </label>
  )
}
