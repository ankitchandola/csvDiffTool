import { compareRecords } from './compare'
import { classifyKeys, type KeyClassification, keyParts } from './keys'
import type {
  CompareProfile,
  CompareSummary,
  CompareWarning,
  FieldChange,
  KeyRef,
  KeyRules,
  ParsedFile,
  SchemaDiff,
} from './types'
import { compileValueRules, RulesError } from './values'

export const MAX_SUMMARY_WARNINGS = 100

export interface ChangedRecord {
  key: KeyRef
  oldIndex: number
  newIndex: number
  changes: FieldChange[]
}

export interface DiffResult {
  summary: CompareSummary
  keys: KeyClassification
  changed: ChangedRecord[]
}

export function schemaDiff(oldHeaders: string[], newHeaders: string[]): SchemaDiff {
  const oldSet = new Set(oldHeaders)
  const newSet = new Set(newHeaders)
  return {
    added: newHeaders.filter((h) => !oldSet.has(h)),
    removed: oldHeaders.filter((h) => !newSet.has(h)),
    shared: oldHeaders.filter((h) => newSet.has(h)),
  }
}

export function checkKeyColumns(schema: SchemaDiff, rules: KeyRules): void {
  if (rules.columns.length === 0) throw new RulesError('Choose at least one key column')
  const missing = rules.columns.filter((c) => !schema.shared.includes(c))
  if (missing.length > 0) {
    throw new RulesError(`Key columns must exist in both files: ${missing.join(', ')}`)
  }
}

export function diffFiles(oldFile: ParsedFile, newFile: ParsedFile, profile: CompareProfile): DiffResult {
  const schema = schemaDiff(oldFile.headers, newFile.headers)
  checkKeyColumns(schema, profile.key)
  const valueRules = compileValueRules(profile.value)
  const columns = schema.shared.filter((c) => !valueRules.ignored.has(c))

  const keys = classifyKeys(oldFile.rows, newFile.rows, profile.key)
  const changed: ChangedRecord[] = []
  const changesByColumn: Record<string, number> = {}
  const warnings: CompareWarning[] = []
  let warningCount = 0

  for (const pair of keys.matched) {
    const newRow = newFile.rows[pair.newIndex]
    const { changes, unparseable } = compareRecords(oldFile.rows[pair.oldIndex], newRow, columns, valueRules)
    for (const { column, side } of unparseable) {
      warningCount++
      if (warnings.length < MAX_SUMMARY_WARNINGS) {
        const index = side === 'old' ? pair.oldIndex : pair.newIndex
        const value = side === 'old' ? oldFile.rows[index][column] : newRow[column]
        warnings.push({
          column,
          side,
          recordNumber: index + 1,
          message: `"${value}" is not a number; compared as text`,
        })
      }
    }
    if (changes.length === 0) continue
    for (const { column } of changes) changesByColumn[column] = (changesByColumn[column] ?? 0) + 1
    changed.push({
      key: { encoded: pair.encoded, parts: keyParts(newRow, profile.key) },
      oldIndex: pair.oldIndex,
      newIndex: pair.newIndex,
      changes,
    })
  }

  return {
    keys,
    changed,
    summary: {
      schema,
      counts: {
        added: keys.added.length,
        removed: keys.removed.length,
        changed: changed.length,
        unchanged: keys.matched.length - changed.length,
        ambiguous: keys.ambiguous.length,
        emptyKey: keys.emptyKey.length,
      },
      changesByColumn,
      warnings,
      warningCount,
      rulesUsed: profile,
    },
  }
}

export function formatSummary(summary: CompareSummary): string {
  const { added, removed, changed } = summary.counts
  const byColumn = Object.entries(summary.changesByColumn)
    .sort(([, a], [, b]) => b - a)
    .map(([column, count]) => `${column}: ${count}`)
  const detail = byColumn.length > 0 ? ` (${byColumn.join(', ')})` : ''
  return `${added} added, ${removed} removed, ${changed} changed${detail}.`
}
