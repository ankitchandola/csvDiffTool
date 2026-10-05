import { checkKeyColumns, diffFiles, schemaDiff } from '../engine/diff'
import { classifyKeys, type KeyClassification } from '../engine/keys'
import { parseCsv } from '../engine/parse'
import type { ParsedFile, Side } from '../engine/types'
import {
  type KeyProblems,
  MAX_REPORTED_KEYS,
  PREVIEW_RECORDS,
  type Requests,
  type Results,
  type WorkerRequest,
} from './protocol'

function keyProblems(keys: KeyClassification): KeyProblems {
  return {
    ambiguous: keys.ambiguous.slice(0, MAX_REPORTED_KEYS),
    emptyKey: keys.emptyKey.slice(0, MAX_REPORTED_KEYS),
  }
}

// Owns the parsed files, so full data never crosses to the UI thread.
export function createHandler() {
  const files: Partial<Record<Side, ParsedFile>> = {}
  const generations: Record<Side, number> = { old: 0, new: 0 }

  function bothFiles(): [ParsedFile, ParsedFile] {
    if (!files.old || !files.new) throw new Error('Load both files first')
    return [files.old, files.new]
  }

  async function parse({ side, file, rules }: Requests['parse']): Promise<Results['parse']> {
    delete files[side]
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
    const { summary, keys } = diffFiles(oldFile, newFile, profile)
    return { summary, ...keyProblems(keys) }
  }

  return async function handle(request: WorkerRequest): Promise<Results[WorkerRequest['type']]> {
    switch (request.type) {
      case 'parse':
        return parse(request)
      case 'checkKeys':
        return checkKeys(request)
      case 'compare':
        return compare(request)
    }
  }
}
