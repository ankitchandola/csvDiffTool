import { describe, expect, it } from 'vitest'
import { type FileState, sheetOf } from './file-state'

const file = new File([''], 'book.xlsx')
const xlsx = { kind: 'xlsx' as const, sheet: 'Data', sheets: ['Summary', 'Data'] }

describe('sheetOf', () => {
  it.each<[string, FileState, string | undefined]>([
    ['loading', { status: 'loading', file, sheet: 'Data' }, 'Data'],
    ['failed', { status: 'failed', file, message: 'Cancelled', sheet: 'Data' }, 'Data'],
    ['invalid', { status: 'invalid', file, issues: { items: [], total: 0 }, format: xlsx }, 'Data'],
    [
      'ready',
      { status: 'ready', file, info: { headers: [], recordCount: 0, format: xlsx, notes: [], preview: [] } },
      'Data',
    ],
    [
      'ready CSV',
      { status: 'ready', file, info: { headers: [], recordCount: 0, format: { kind: 'csv', delimiter: ',' }, notes: [], preview: [] } },
      undefined,
    ],
  ])('keeps the selected sheet of a %s file', (_, state, expected) => {
    expect(sheetOf(state)).toBe(expected)
  })
})
