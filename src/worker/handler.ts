import { type ChangedRecord, checkKeyColumns, diffFiles, type DiffResult, schemaDiff } from '../engine/diff'
import { classifyKeys, encodeKey, type KeyClassification, keyParts, normaliseKeyPart } from '../engine/keys'
import { DEFAULT_LIMITS, type Limits } from '../engine/limits'
import type { ParseIssue } from '../engine/parse'
import { buildChangesCsv, buildJsonReport } from '../engine/report'
import type { AmbiguousKey, KeyRef, KeyRules, ParsedFile, ProgressFn, Row, Side } from '../engine/types'
import { readSource } from './read-source'
import { createSearchCache, matches, normaliseSearch } from './search'
import {
  type AmbiguousKeyPreview,
  type AmbiguousRecord,
  type KeyProblems,
  MAX_GROUP_MEMBERS,
  MAX_PAGE_SIZE,
  type Preview,
  PREVIEW_ISSUES,
  PREVIEW_PROBLEMS,
  PREVIEW_RECORDS,
  PREVIEW_WARNINGS,
  type RecordEntry,
  type Requests,
  type Results,
  type WorkerRequest,
} from './protocol'

export { LEGACY_EXCEL_MESSAGE } from './read-source'

function preview<T>(items: T[], size: number): Preview<T> {
  return { items: items.slice(0, size), total: items.length }
}

function capMembers(group: AmbiguousKey): AmbiguousKeyPreview {
  return {
    encoded: group.encoded,
    old: group.old.slice(0, MAX_GROUP_MEMBERS),
    new: group.new.slice(0, MAX_GROUP_MEMBERS),
    oldCount: group.old.length,
    newCount: group.new.length,
  }
}

function keyProblems(keys: KeyClassification): KeyProblems {
  return {
    ambiguous: { items: keys.ambiguous.slice(0, PREVIEW_PROBLEMS).map(capMembers), total: keys.ambiguous.length },
    emptyKey: preview(keys.emptyKey, PREVIEW_PROBLEMS),
  }
}

function keyRef(row: Row, rules: KeyRules): KeyRef {
  const parts = keyParts(row, rules)
  return { encoded: encodeKey(parts.map((part) => normaliseKeyPart(part, rules))), parts }
}

function pageBounds(offset: number, limit: number): [number, number] {
  const start = Math.max(0, Math.floor(offset))
  return [start, start + Math.min(MAX_PAGE_SIZE, Math.max(0, Math.floor(limit)))]
}

// Owns the parsed files, their complete diagnostics and the latest diff, so full data
// never crosses to the UI thread.
export function createHandler(limits: Limits = DEFAULT_LIMITS) {
  const files: Partial<Record<Side, ParsedFile>> = {}
  const fileNames: Partial<Record<Side, string>> = {}
  const issues: Partial<Record<Side, ParseIssue[]>> = {}
  const generations: Record<Side, number> = { old: 0, new: 0 }
  let latest: {
    diff: DiffResult
    oldFile: ParsedFile
    newFile: ParsedFile
    resultId: number
    oldName: string
    newName: string
    changedByColumn: Map<string, ChangedRecord[]>
    ambiguousRecords: AmbiguousRecord[] | null
  } | null = null
  let nextResultId = 1
  const searchCache = createSearchCache()

  function bothFiles(): [ParsedFile, ParsedFile] {
    if (!files.old || !files.new) throw new Error('Load both files first')
    return [files.old, files.new]
  }

  async function parse({ side, file, rules, sheet }: Requests['parse'], onProgress?: ProgressFn): Promise<Results['parse']> {
    delete files[side]
    delete issues[side]
    latest = null
    const generation = ++generations[side]
    const { outcome } = await readSource(file, { rules, sheet }, limits, () => generation === generations[side], onProgress)
    if (!outcome.ok) {
      issues[side] = outcome.issues
      return { ok: false, issues: preview(outcome.issues, PREVIEW_ISSUES), ...(outcome.format && { format: outcome.format }) }
    }
    files[side] = outcome.file
    fileNames[side] = file.name
    const { headers, rows, format, notes } = outcome.file
    return { ok: true, info: { headers, format, notes, recordCount: rows.length, preview: rows.slice(0, PREVIEW_RECORDS) } }
  }

  function getIssues({ side, offset, limit }: Requests['getIssues']): Results['getIssues'] {
    const all = issues[side] ?? []
    const [start, end] = pageBounds(offset, limit)
    return { side, total: all.length, offset: start, items: all.slice(start, end) }
  }

  function checkKeys({ rules }: Requests['checkKeys'], onProgress?: ProgressFn): Results['checkKeys'] {
    const [oldFile, newFile] = bothFiles()
    checkKeyColumns(schemaDiff(oldFile.headers, newFile.headers), rules)
    const keys = classifyKeys(oldFile.rows, newFile.rows, rules, onProgress)
    return {
      counts: { matched: keys.matched.length, added: keys.added.length, removed: keys.removed.length },
      ...keyProblems(keys),
    }
  }

  function compare({ profile }: Requests['compare'], onProgress?: ProgressFn): Results['compare'] {
    const [oldFile, newFile] = bothFiles()
    latest = null
    const diff = diffFiles(oldFile, newFile, profile, onProgress)
    const resultId = nextResultId++
    latest = {
      diff,
      oldFile,
      newFile,
      resultId,
      oldName: fileNames.old ?? 'old.csv',
      newName: fileNames.new ?? 'new.csv',
      changedByColumn: new Map(), ambiguousRecords: null }
    const ambiguousRecordCount = diff.keys.ambiguous.reduce((n, g) => n + g.old.length + g.new.length, 0)
    return { resultId, ambiguousRecordCount, summary: diff.summary, warnings: preview(diff.warnings, PREVIEW_WARNINGS), ...keyProblems(diff.keys) }
  }

  function changedRecords(column: string | undefined): ChangedRecord[] {
    if (!latest) throw new Error('Compare the files first')
    if (column === undefined) return latest.diff.changed
    let filtered = latest.changedByColumn.get(column)
    if (!filtered) {
      filtered = latest.diff.changed.filter((c) => c.changes.some((change) => change.column === column))
      latest.changedByColumn.set(column, filtered)
    }
    return filtered
  }

  function ambiguousRecords(): AmbiguousRecord[] {
    if (!latest) throw new Error('Compare the files first')
    latest.ambiguousRecords ??= latest.diff.keys.ambiguous.flatMap((group) => {
      const counts = { oldCount: group.old.length, newCount: group.new.length }
      return [
        ...group.old.map((r) => ({ encoded: group.encoded, side: 'old' as const, ...r, ...counts })),
        ...group.new.map((r) => ({ encoded: group.encoded, side: 'new' as const, ...r, ...counts })),
      ]
    })
    return latest.ambiguousRecords
  }

  function current(resultId: number): NonNullable<typeof latest> {
    if (!latest) throw new Error('Compare the files first')
    if (resultId !== latest.resultId) throw new Error('These results were replaced by a newer comparison')
    return latest
  }

  async function exportResult({ resultId, format, escapeFormulae }: Requests['export'], onProgress?: ProgressFn): Promise<Results['export']> {
    const { diff, oldFile, newFile, oldName, newName } = current(resultId)
    const input = { diff, oldFile, newFile, oldName, newName, generatedAt: new Date().toISOString() }
    switch (format) {
      case 'csv':
        return new Blob(buildChangesCsv(input, { escapeFormulae }, onProgress), { type: 'text/csv;charset=utf-8' })
      case 'json':
        return new Blob(buildJsonReport(input, onProgress), { type: 'application/json' })
      case 'xlsx': {
        const { buildXlsxReport, MAX_CELL_CHARS, MAX_SHEET_COLUMNS, MAX_SHEET_ROWS } = await import('../engine/xlsx-report')
        const bytes = buildXlsxReport(
          input,
          {
            maxSheetRows: MAX_SHEET_ROWS,
            maxSheetColumns: MAX_SHEET_COLUMNS,
            maxCellChars: MAX_CELL_CHARS,
            maxCells: limits.maxXlsxExportCells,
            maxTextChars: limits.maxXlsxExportText,
          },
          onProgress,
        )
        return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      }
    }
  }

  function getRows({ resultId, tab, offset, limit, column, search }: Requests['getRows']): Results['getRows'] {
    const { diff, oldFile, newFile } = current(resultId)
    const [start, end] = pageBounds(offset, limit)
    const rules = diff.summary.rulesUsed.key
    const needle = normaliseSearch(search)
    const filtered = <T,>(list: T[], texts: (item: T) => Iterable<string>): T[] =>
      needle === '' ? list : searchCache.get(`${resultId}\u0000${tab}\u0000${column ?? ''}\u0000${needle}`, () => list.filter((item) => matches(texts(item), needle)))

    switch (tab) {
      case 'changed': {
        const changed = filtered(changedRecords(column), (c) => [
          ...c.key.parts,
          ...keyParts(oldFile.rows[c.oldIndex], rules),
          ...c.changes.flatMap((change) => [change.column, change.before, change.after]),
        ])
        return {
          tab,
          total: changed.length,
          offset: start,
          items: changed.slice(start, end).map((c) => ({
            key: c.key,
            oldKeyParts: keyParts(oldFile.rows[c.oldIndex], rules),
            oldRecordNumber: c.oldIndex + 1,
            newRecordNumber: c.newIndex + 1,
            changes: c.changes,
          })),
        }
      }
      case 'added':
      case 'removed': {
        const rows = tab === 'added' ? newFile.rows : oldFile.rows
        const indices = filtered(tab === 'added' ? diff.keys.added : diff.keys.removed, (index) => Object.values(rows[index]))
        const items = indices
          .slice(start, end)
          .map((index): RecordEntry => ({ key: keyRef(rows[index], rules), recordNumber: index + 1, row: rows[index] }))
        return { tab, total: indices.length, offset: start, items }
      }
      case 'ambiguous': {
        const records = filtered(ambiguousRecords(), (r) => r.parts)
        return { tab, total: records.length, offset: start, items: records.slice(start, end) }
      }
      case 'emptyKey': {
        const records = filtered(diff.keys.emptyKey, (r) => r.parts)
        return { tab, total: records.length, offset: start, items: records.slice(start, end) }
      }
      case 'warnings': {
        const warnings = filtered(diff.warnings, (w) => [w.column, w.message])
        return { tab, total: warnings.length, offset: start, items: warnings.slice(start, end) }
      }
    }
  }

  return async function handle(request: WorkerRequest, onProgress?: ProgressFn): Promise<Results[WorkerRequest['type']]> {
    switch (request.type) {
      case 'parse':
        return parse(request, onProgress)
      case 'getIssues':
        return getIssues(request)
      case 'checkKeys':
        return checkKeys(request, onProgress)
      case 'compare':
        return compare(request, onProgress)
      case 'getRows':
        return getRows(request)
      case 'export':
        return exportResult(request, onProgress)
    }
  }
}
