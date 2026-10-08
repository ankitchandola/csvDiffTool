import { describe, expect, it } from 'vitest'
import { parseDecimal, type Decimal } from '../engine/decimal'
import { computeBridge, type BridgeInput } from './accounting'
import { computeStatuses, type ReviewFacts, setupFingerprint } from './statuses'

function d(text: string): Decimal {
  return parseDecimal(text) as Decimal
}

// The spec's identity example: the same receipt on each side, both left unmatched.
const IDENTITY: BridgeInput = {
  sides: {
    bank: { balances: { opening: d('0'), closing: d('100') }, movement: d('100'), invalidRows: 0 },
    books: { balances: { opening: d('0'), closing: d('100') }, movement: d('100'), invalidRows: 0 },
  },
  openingAll: { bank: [], books: [] },
  openingRemaining: { bank: [], books: [] },
  unmatched: { bank: [d('100')], books: [d('100')] },
  confirmedDifferences: [],
  incompleteSearch: false,
}

const REVIEWED: ReviewFacts = { unclassified: 0, problems: 0, sourceIssues: [], unexplainedVariances: 0, completion: { marked: true, current: true } }

describe('computeStatuses', () => {
  it('never marks complete on a balanced bridge alone', () => {
    const statuses = computeStatuses(computeBridge(IDENTITY), { ...REVIEWED, unclassified: 2, completion: { marked: false, current: false } })
    expect(statuses.bridgeComplete.earned).toBe(true)
    expect(statuses.outstandingReviewed).toEqual({ earned: false, reasons: ['2 unmatched items are not classified'] })
    expect(statuses.canMarkComplete).toBe(false)
    expect(statuses.completed.earned).toBe(false)
  })

  it('completes only with every status earned and a current mark', () => {
    const bridge = computeBridge(IDENTITY)
    expect(computeStatuses(bridge, REVIEWED).completed).toEqual({ earned: true, reasons: [] })
    expect(computeStatuses(bridge, { ...REVIEWED, completion: { marked: false, current: false } }).completed.reasons).toEqual(['Not marked complete'])
    expect(computeStatuses(bridge, { ...REVIEWED, completion: { marked: true, current: false } }).completed.reasons).toEqual([
      'Marked complete earlier, but decisions or the setup changed since',
    ])
  })

  it('blocks completion on problems or unexplained variances, even when marked', () => {
    const bridge = computeBridge(IDENTITY)
    const statuses = computeStatuses(bridge, { ...REVIEWED, problems: 1, unexplainedVariances: 2 })
    expect(statuses.canMarkComplete).toBe(false)
    expect(statuses.completed.reasons).toEqual(['1 row has a problem', '2 confirmed matches have an unexplained difference'])
  })

  it('lists every reason it is not ready to mark complete once, and none of the mark itself', () => {
    const missing = computeBridge({ ...IDENTITY, sides: { ...IDENTITY.sides, bank: { ...IDENTITY.sides.bank, balances: { opening: null, closing: null } } } })
    const statuses = computeStatuses(missing, { ...REVIEWED, unclassified: 1, problems: 1, completion: { marked: false, current: false } })
    expect(statuses.notReady).toEqual(['Bank: opening and closing balances are needed', '1 unmatched item is not classified', '1 row has a problem'])
    expect(computeStatuses(computeBridge(IDENTITY), { ...REVIEWED, completion: { marked: false, current: false } }).notReady).toEqual([])
  })

  it('reports source and bridge gaps separately', () => {
    const missing = computeBridge({ ...IDENTITY, sides: { ...IDENTITY.sides, bank: { ...IDENTITY.sides.bank, balances: { opening: null, closing: null } } } })
    const statuses = computeStatuses(missing, REVIEWED)
    expect(statuses.sourcesValidated.reasons).toEqual(['Bank: opening and closing balances are needed'])
    expect(statuses.bridgeComplete.earned).toBe(false)
  })
})

describe('setupFingerprint', () => {
  it('is stable for equal setups and changes with any field', () => {
    const setup = { rules: { bankDaysAfter: 3 }, balances: { bank: '1000.00' } }
    expect(setupFingerprint(setup)).toBe(setupFingerprint(JSON.parse(JSON.stringify(setup))))
    expect(setupFingerprint(setup)).not.toBe(setupFingerprint({ ...setup, balances: { bank: '1000.01' } }))
    expect(setupFingerprint(setup)).toMatch(/^[0-9a-f]{16}$/)
  })
})
