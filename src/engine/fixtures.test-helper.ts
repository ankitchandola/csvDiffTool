import { parseCsv } from './parse'
import type { CompareProfile, KeyRules, ParsedFile, ValueRules } from './types'

const files = import.meta.glob<string>('../../fixtures/*/*.csv', {
  query: '?raw',
  import: 'default',
  eager: true,
})

export function fixtureText(name: string, side: 'old' | 'new'): string {
  const text = files[`../../fixtures/${name}/${side}.csv`]
  if (text === undefined) throw new Error(`Missing fixture ${name}/${side}.csv`)
  return text
}

export function parsedFixture(name: string, side: 'old' | 'new'): ParsedFile {
  const outcome = parseCsv(fixtureText(name, side), { delimiter: 'auto', trimHeaders: true })
  if (!outcome.ok) throw new Error(`Fixture ${name}/${side} failed to parse: ${JSON.stringify(outcome.issues)}`)
  return outcome.file
}

export function profile(key: Partial<KeyRules> & Pick<KeyRules, 'columns'>, value: Partial<ValueRules> = {}): CompareProfile {
  return {
    name: 'test',
    parse: { delimiter: 'auto', trimHeaders: true },
    key: { trim: true, caseInsensitive: false, ...key },
    value: { ignoredColumns: [], trim: false, caseInsensitive: [], numeric: {}, ...value },
  }
}
