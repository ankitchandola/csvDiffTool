import { checkKeyColumns, diffFiles, type DiffResult, schemaDiff } from '../engine/diff'
import { classifyKeys, encodeKey, type KeyClassification, keyParts, normaliseKeyPart } from '../engine/keys'
import { parseCsv } from '../engine/parse'
import type { KeyRef, KeyRules, ParsedFile, Row, Side } from '../engine/types'
import {
  type KeyProblems,
  MAX_GROUP_MEMBERS,
  MAX_PAGE_SIZE,
  MAX_REPORTED_KEYS,
  PREVIEW_RECORDS,
  type RecordEntry,
  type Requests,
  type Results,
  type WorkerRequest,
} from './protocol'

function keyProblems(keys: KeyClassification): KeyProblems {
  return {
    ambiguous: keys.ambiguous.slice(0, MAX_REPORTED_KEYS).map((group) => ({
      encoded: group.encoded,
      old: group.old.slice(0, MAX_GROUP_MEMBERS),
      new: group.new.slice(0, MAX_GROUP_MEMBERS),
      oldCount: group.old.length,
      newCount: group.new.length,
    })),
    emptyKey: keys.emptyKey.slice(0, MAX_REPORTED_KEYS),
  }
}

function keyRef(row: Row, rules: KeyRules): KeyRef {
  const parts = keyParts(row, rules)
  return { encoded: encodeKey(parts.map((part) => normaliseKeyPart(part, rules))), parts }
}

// Owns the parsed files and the latest diff, so full data never crosses to the UI thread.
export function createHandler() {
  const files: Partial<Record<Side, ParsedFile>> = {}
  const generations: Record<Side, number> = { old: 0, new: 0 }
  let latest: { diff: DiffResult; oldFile: ParsedFile; newFile: ParsedFile } | null = null

  function bothFiles(): [ParsedFile, ParsedFile] {
    if (!files.old || !files.new) throw new Error('Load both files first')
    return [files.old, files.new]
  }

  async function parse({ side, file, rules }: Requests['parse']): Promise<Results['parse']> {
    delete files[side]
    latest = null
    const generation = ++generations[side]
    const outcome = parseCsv(await file.text(), rules)
    if (!outcome.ok) return outcome
    // A newer file for this side was picked while this one was being read.
    if (generation !== generations[side]) throw new Error('Superseded by a newer file')
    files[side] = outcome.file
    const { headers, rows, delimiter } = outcome.file
    return { ok: true, info: { headers, delimiter, recordCount: rows.length, preview: rows.slice(0, PREVIEW_RECORDS) } }
  }

  function checkKeys({ rules }: Requests['checkKeys']): Results['checkKeys'] {
    const [oldFile, newFile] = bothFiles()
    checkKeyColumns(schemaDiff(oldFile.headers, newFile.headers), rules)
    const keys = classifyKeys(oldFile.rows, newFile.rows, rules)
    return {
      counts: {
        matched: keys.matched.length,
        added: keys.added.length,
        removed: keys.removed.length,
        ambiguous: keys.ambiguous.length,
        emptyKey: keys.emptyKey.length,
      },
      ...keyProblems(keys),
    }
  }

  function compare({ profile }: Requests['compare']): Results['compare'] {
    const [oldFile, newFile] = bothFiles()
    latest = null
    const diff = diffFiles(oldFile, newFile, profile)
    latest = { diff, oldFile, newFile }
    return { summary: diff.summary, ...keyProblems(diff.keys) }
  }

  function getRows({ tab, offset, limit }: Requests['getRows']): Results['getRows'] {
    if (!latest) throw new Error('Compare the files first')
    const { diff, oldFile, newFile } = latest
    const start = Math.max(0, Math.floor(offset))
    const end = start + Math.min(MAX_PAGE_SIZE, Math.max(0, Math.floor(limit)))
    const rules = diff.summary.rulesUsed.key

    if (tab === 'changed') {
      return {
        tab,
        total: diff.changed.length,
        offset: start,
        items: diff.changed.slice(start, end).map((c) => ({
          key: c.key,
          oldRecordNumber: c.oldIndex + 1,
          newRecordNumber: c.newIndex + 1,
          changes: c.changes,
        })),
      }
    }
    const indices = tab === 'added' ? diff.keys.added : diff.keys.removed
    const rows = tab === 'added' ? newFile.rows : oldFile.rows
    const items = indices.slice(start, end).map(
      (index): RecordEntry => ({ key: keyRef(rows[index], rules), recordNumber: index + 1, row: rows[index] }),
    )
    return { tab, total: indices.length, offset: start, items }
  }

  return async function handle(request: WorkerRequest): Promise<Results[WorkerRequest['type']]> {
    switch (request.type) {
      case 'parse':
        return parse(request)
      case 'checkKeys':
        return checkKeys(request)
      case 'compare':
        return compare(request)
      case 'getRows':
        return getRows(request)
    }
  }
}
