import { describe, expect, it } from 'vitest'
import { firstRelevantTab } from './tabs'

describe('firstRelevantTab', () => {
  it.each([
    [{ added: 1, removed: 1, changed: 1 }, 0, 'changed'],
    [{ added: 3, removed: 0, changed: 0 }, 0, 'added'],
    [{ added: 0, removed: 2, changed: 0 }, 5, 'removed'],
    [{ added: 0, removed: 0, changed: 0 }, 5, 'problems'],
    [{ added: 0, removed: 0, changed: 0 }, 0, 'changed'],
  ] as const)('opens %o with %i problems on %s', (counts, problems, expected) => {
    expect(firstRelevantTab(counts, problems)).toBe(expected)
  })
})
