import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  disabled?: boolean
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const search = useRef({ text: '', time: 0 })
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [position, setPosition] = useState<CSSProperties>({})
  const selected = options.findIndex((option) => option.value === value)
  const expanded = open && !disabled && options.length > 0
  const activeIndex = Math.min(active, options.length - 1)

  function show(index = Math.max(0, selected)) {
    search.current = { text: '', time: 0 }
    setActive(index)
    setOpen(true)
  }

  function choose(index: number) {
    onChange(options[index].value)
    setOpen(false)
    trigger.current?.focus()
  }

  function place(): boolean {
    if (!trigger.current) return false
    const rect = trigger.current.getBoundingClientRect()
    if (rect.bottom < 0 || rect.top > window.innerHeight) return false
    const below = window.innerHeight - rect.bottom - 12
    const above = rect.top - 12
    const upwards = below < 200 && above > below
    const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 24)
    setPosition({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      width,
      maxHeight: Math.min(280, Math.max(80, upwards ? above : below)),
      ...(upwards ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
    })
    return true
  }

  useLayoutEffect(() => {
    if (expanded) place()
    // oxlint-disable-next-line react/exhaustive-deps -- place only reads the trigger's position when the menu opens.
  }, [expanded])

  useEffect(() => {
    if (!expanded) return
    // Scrolls the list only: scrollIntoView would scroll the page too, which closes the menu.
    const menu = list.current
    const active = menu?.querySelector<HTMLElement>('[data-active="true"]')
    if (!menu || !active) return
    if (active.offsetTop < menu.scrollTop) menu.scrollTop = active.offsetTop
    else if (active.offsetTop + active.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = active.offsetTop + active.offsetHeight - menu.clientHeight
  }, [expanded, activeIndex])

  useEffect(() => {
    if (!expanded) return
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !list.current?.contains(event.target)) {
        setOpen(false)
      }
    }
    // The menu follows its trigger when the page scrolls or shifts, and closes once the trigger is off screen.
    function follow(event?: Event) {
      if (event?.target instanceof Node && list.current?.contains(event.target)) return
      if (!place()) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
    }
  }, [expanded])

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="select-trigger"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-controls={expanded ? id : undefined}
        aria-activedescendant={expanded ? `${id}-${activeIndex}` : undefined}
        disabled={disabled || options.length === 0}
        onClick={() => expanded ? setOpen(false) : show()}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'Tab') {
            setOpen(false)
            return
          }
          if (event.key === 'Escape' && expanded) {
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
            return
          }
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
              : !expanded ? Math.max(0, selected)
              : (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
            if (!expanded) show(next)
            else setActive(next)
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            if (expanded) choose(activeIndex)
            else show()
          } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault()
            const now = Date.now()
            const text = (now - search.current.time < 600 ? search.current.text : '') + event.key.toLowerCase()
            search.current = { text, time: now }
            const prefix = [...text].every((char) => char === text[0]) ? text[0] : text
            const start = expanded ? activeIndex : selected
            const index = options.findIndex((_, offset) =>
              options[(Math.max(0, start) + offset + 1) % options.length].label.toLowerCase().startsWith(prefix),
            )
            if (index >= 0) {
              setActive((Math.max(0, start) + index + 1) % options.length)
              setOpen(true)
            }
          }
        }}
      >
        <span>{options[selected]?.label ?? 'Choose an option'}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {expanded && createPortal(
        <div ref={list} id={id} role="listbox" aria-label={label} className="select-menu" style={position}>
          {options.map((option, index) => (
            <div
              key={option.value}
              id={`${id}-${index}`}
              role="option"
              aria-selected={option.value === value}
              data-active={index === activeIndex}
              className="select-option"
              onMouseDown={(event) => event.preventDefault()}
              onPointerMove={() => setActive(index)}
              onClick={() => choose(index)}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={15} aria-hidden="true" />}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}
