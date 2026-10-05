import { type ChangedRecord, checkKeyColumns, diffFiles, type DiffResult, schemaDiff } from '../engine/diff'
import { classifyKeys, encodeKey, type KeyClassification, keyParts, normaliseKeyPart } from '../engine/keys'
import { decodeUtf8, NOT_UTF8_MESSAGE, type ParseIssue, parseCsv } from '../engine/parse'
import type { AmbiguousKey, KeyRef, KeyRules, ParsedFile, Row, Side } from '../engine/types'
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
export function createHandler() {
  const files: Partial<Record<Side, ParsedFile>> = {}
  const issues: Partial<Record<Side, ParseIssue[]>> = {}
  const generations: Record<Side, number> = { old: 0, new: 0 }
  let latest: {
    diff: DiffResult
    oldFile: ParsedFile
    newFile: ParsedFile
    resultId: number
    changedByColumn: Map<string, ChangedRecord[]>
    ambiguousRecords: AmbiguousRecord[] | null
  } | null = null
  let nextResultId = 1

  function bothFiles(): [ParsedFile, ParsedFile] {
    if (!files.old || !files.new) throw new Error('Load both files first')
    return [files.old, files.new]
  }

  async function parse({ side, file, rules }: Requests['parse']): Promise<Results['parse']> {
    delete files[side]
    delete issues[side]
    latest = null
    const generation = ++generations[side]
    const text = decodeUtf8(await file.arrayBuffer())
    // A newer file for this side was picked while this one was being read.
    if (generation !== generations[side]) throw new Error('Superseded by a newer file')
    const outcome =
      text === null ? { ok: false as const, issues: [{ kind: 'file' as const, message: NOT_UTF8_MESSAGE }] } : parseCsv(text, rules)
    if (!outcome.ok) {
      issues[side] = outcome.issues
      return { ok: false, issues: preview(outcome.issues, PREVIEW_ISSUES) }
    }
    files[side] = outcome.file
    const { headers, rows, delimiter } = outcome.file
    return { ok: true, info: { headers, delimiter, recordCount: rows.length, preview: rows.slice(0, PREVIEW_RECORDS) } }
  }

  function getIssues({ side, offset, limit }: Requests['getIssues']): Results['getIssues'] {
    const all = issues[side] ?? []
    const [start, end] = pageBounds(offset, limit)
    return { side, total: all.length, offset: start, items: all.slice(start, end) }
  }

  function checkKeys({ rules }: Requests['checkKeys']): Results['checkKeys'] {
    const [oldFile, newFile] = bothFiles()
    checkKeyColumns(schemaDiff(oldFile.headers, newFile.headers), rules)
    const keys = classifyKeys(oldFile.rows, newFile.rows, rules)
    return {
      counts: { matched: keys.matched.length, added: keys.added.length, removed: keys.removed.length },
      ...keyProblems(keys),
    }
  }

  function compare({ profile }: Requests['compare']): Results['compare'] {
    const [oldFile, newFile] = bothFiles()
    latest = null
    const diff = diffFiles(oldFile, newFile, profile)
    const resultId = nextResultId++
    latest = { diff, oldFile, newFile, resultId, changedByColumn: new Map(), ambiguousRecords: null }
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

  function getRows({ resultId, tab, offset, limit, column }: Requests['getRows']): Results['getRows'] {
    if (!latest) throw new Error('Compare the files first')
    if (resultId !== latest.resultId) throw new Error('These results were replaced by a newer comparison')
    const { diff, oldFile, newFile } = latest
    const [start, end] = pageBounds(offset, limit)
    const rules = diff.summary.rulesUsed.key

    switch (tab) {
      case 'changed': {
        const changed = changedRecords(column)
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
        const indices = tab === 'added' ? diff.keys.added : diff.keys.removed
        const rows = tab === 'added' ? newFile.rows : oldFile.rows
        const items = indices
          .slice(start, end)
          .map((index): RecordEntry => ({ key: keyRef(rows[index], rules), recordNumber: index + 1, row: rows[index] }))
        return { tab, total: indices.length, offset: start, items }
      }
      case 'ambiguous': {
        const records = ambiguousRecords()
        return { tab, total: records.length, offset: start, items: records.slice(start, end) }
      }
      case 'emptyKey':
        return { tab, total: diff.keys.emptyKey.length, offset: start, items: diff.keys.emptyKey.slice(start, end) }
      case 'warnings':
        return { tab, total: diff.warnings.length, offset: start, items: diff.warnings.slice(start, end) }
    }
  }

  return async function handle(request: WorkerRequest): Promise<Results[WorkerRequest['type']]> {
    switch (request.type) {
      case 'parse':
        return parse(request)
      case 'getIssues':
        return getIssues(request)
      case 'checkKeys':
        return checkKeys(request)
      case 'compare':
        return compare(request)
      case 'getRows':
        return getRows(request)
    }
  }
}
