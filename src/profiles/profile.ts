import { parseDecimal } from '../engine/decimal'
import type { CompareProfile, KeyRules, NumericRule, ParseRules, ValueRules } from '../engine/types'

export const PROFILE_FORMAT = 'csv-diff-profile'
export const PROFILE_VERSION = 1

export class ProfileError extends Error {}

export interface ProfileFile {
  format: typeof PROFILE_FORMAT
  version: typeof PROFILE_VERSION
  profile: CompareProfile
}

type Fields = Record<string, unknown>

function record(value: unknown, path: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProfileError(`${path} must be an object`)
  }
  return value as Fields
}

// Unknown fields are rejected: a typo such as "ignoreColumns" would otherwise drop a rule silently.
function only(fields: Fields, allowed: string[], path: string): void {
  const unknown = Object.keys(fields).filter((k) => !allowed.includes(k))
  if (unknown.length > 0) throw new ProfileError(`${path} has unknown field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`)
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ProfileError(`${path} must be true or false`)
  return value
}

function columnList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((c) => typeof c !== 'string' || c === '')) {
    throw new ProfileError(`${path} must be a list of column names`)
  }
  const columns = value as string[]
  const duplicate = columns.find((c, i) => columns.indexOf(c) !== i)
  if (duplicate !== undefined) throw new ProfileError(`${path} lists "${duplicate}" more than once`)
  return [...columns]
}

function readParse(value: unknown): ParseRules {
  const fields = record(value, 'parse')
  only(fields, ['delimiter', 'trimHeaders'], 'parse')
  const { delimiter, trimHeaders } = fields
  if (delimiter !== 'auto' && delimiter !== ',' && delimiter !== ';' && delimiter !== '\t') {
    throw new ProfileError('parse.delimiter must be "auto", ",", ";" or a tab')
  }
  if (trimHeaders !== true) throw new ProfileError('parse.trimHeaders must be true')
  return { delimiter, trimHeaders }
}

function readKey(value: unknown): KeyRules {
  const fields = record(value, 'key')
  only(fields, ['columns', 'trim', 'caseInsensitive'], 'key')
  const columns = columnList(fields.columns, 'key.columns')
  if (columns.length === 0) throw new ProfileError('key.columns must name at least one column')
  return { columns, trim: bool(fields.trim, 'key.trim'), caseInsensitive: bool(fields.caseInsensitive, 'key.caseInsensitive') }
}

function readNumeric(value: unknown): Record<string, NumericRule> {
  const fields = record(value, 'value.numeric')
  const entries = Object.entries(fields).map(([column, raw]): [string, NumericRule] => {
    const path = `value.numeric["${column}"]`
    const rule = record(raw, path)
    only(rule, ['tolerance', 'stripThousandsSeparator'], path)
    const tolerance = rule.tolerance
    const parsed = typeof tolerance === 'string' ? parseDecimal(tolerance.trim()) : null
    if (typeof tolerance !== 'string' || parsed === null || parsed.units < 0n) {
      throw new ProfileError(`${path}.tolerance must be a non-negative decimal written as text, such as "0.01"`)
    }
    return [column, { tolerance, stripThousandsSeparator: bool(rule.stripThousandsSeparator, `${path}.stripThousandsSeparator`) }]
  })
  // fromEntries defines own properties, so a column named "__proto__" stays an ordinary key.
  return Object.fromEntries(entries)
}

function readValue(value: unknown): ValueRules {
  const fields = record(value, 'value')
  only(fields, ['ignoredColumns', 'trim', 'caseInsensitive', 'numeric'], 'value')
  return {
    ignoredColumns: columnList(fields.ignoredColumns, 'value.ignoredColumns'),
    trim: bool(fields.trim, 'value.trim'),
    caseInsensitive: columnList(fields.caseInsensitive, 'value.caseInsensitive'),
    numeric: readNumeric(fields.numeric),
  }
}

export function readProfile(value: unknown): CompareProfile {
  const fields = record(value, 'profile')
  only(fields, ['name', 'parse', 'key', 'value'], 'profile')
  const name = typeof fields.name === 'string' ? fields.name.trim() : ''
  if (name === '') throw new ProfileError('profile.name must be a non-empty name')
  return { name, parse: readParse(fields.parse), key: readKey(fields.key), value: readValue(fields.value) }
}

export function toProfileFile(profile: CompareProfile): ProfileFile {
  return { format: PROFILE_FORMAT, version: PROFILE_VERSION, profile }
}

export function readProfileFile(value: unknown): CompareProfile {
  const fields = record(value, 'The file')
  if (fields.format !== PROFILE_FORMAT) throw new ProfileError('This is not a Recon Desk profile')
  if (typeof fields.version !== 'number' || fields.version > PROFILE_VERSION) {
    throw new ProfileError('This profile was made by a newer version of Recon Desk')
  }
  only(fields, ['format', 'version', 'profile'], 'The file')
  return readProfile(fields.profile)
}

export function exportProfile(profile: CompareProfile): string {
  return JSON.stringify(toProfileFile(profile), null, 2) + '\n'
}

export function importProfile(text: string): CompareProfile {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ProfileError('The file is not valid JSON')
  }
  return readProfileFile(value)
}

export function sameRules(a: CompareProfile, b: CompareProfile): boolean {
  return JSON.stringify([a.parse, a.key, a.value]) === JSON.stringify([b.parse, b.key, b.value])
}

export interface MissingColumns {
  key: string[]
  rules: string[]
}

// Profile drift: a saved profile may name columns the loaded files no longer have.
// Missing key columns block comparison; missing rule columns only mean those rules do nothing.
export function missingColumns(profile: Pick<CompareProfile, 'key' | 'value'>, shared: string[]): MissingColumns {
  const present = new Set(shared)
  const ruleColumns = new Set([
    ...profile.value.ignoredColumns,
    ...profile.value.caseInsensitive,
    ...Object.keys(profile.value.numeric),
  ])
  return {
    key: profile.key.columns.filter((c) => !present.has(c)),
    rules: [...ruleColumns].filter((c) => !present.has(c)),
  }
}

export function profileFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'profile'}.csv-diff-profile.json`
}
