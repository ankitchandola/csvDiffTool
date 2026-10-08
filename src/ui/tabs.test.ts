import { describe, expect, it } from 'vitest'
import { tabKeyTarget } from './tabs'

describe('tabKeyTarget', () => {
  it('moves with the arrow keys and wraps at both ends', () => {
    expect(tabKeyTarget('ArrowRight', 1, 4)).toBe(2)
    expect(tabKeyTarget('ArrowRight', 3, 4)).toBe(0)
    expect(tabKeyTarget('ArrowLeft', 1, 4)).toBe(0)
    expect(tabKeyTarget('ArrowLeft', 0, 4)).toBe(3)
  })

  it('jumps to the first and last tab', () => {
    expect(tabKeyTarget('Home', 2, 4)).toBe(0)
    expect(tabKeyTarget('End', 0, 4)).toBe(3)
  })

  it('ignores other keys', () => {
    expect(tabKeyTarget('Enter', 1, 4)).toBeNull()
    expect(tabKeyTarget('ArrowDown', 1, 4)).toBeNull()
  })
})
