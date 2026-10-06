import { describe, expect, it } from 'vitest'
import { counted, noun } from './format'

describe('counted', () => {
  it('uses the singular only for exactly one', () => {
    expect(counted(1, 'ambiguous key')).toBe('1 ambiguous key')
    expect(counted(0, 'ambiguous key')).toBe('0 ambiguous keys')
    expect(counted(1200, 'record')).toBe('1,200 records')
  })

  it('takes an irregular plural', () => {
    expect(noun(2, 'entry', 'entries')).toBe('entries')
    expect(noun(1, 'entry', 'entries')).toBe('entry')
  })
})
