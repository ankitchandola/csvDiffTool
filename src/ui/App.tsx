import { useEffect, useMemo, useRef, useState } from 'react'
import { schemaDiff } from '../engine/diff'
import type { CompareProfile, KeyRules, ParseRules, Side, ValueRules } from '../engine/types'
import { type CompareClient, createCompareClient } from '../worker/client'
import type { CompareResult, KeyReport } from '../worker/protocol'
import { FilePanel, type FileState } from './FilePanel'
import { KeyProblemsList } from './KeyProblemsList'
import { KeyRulesForm, ValueRulesForm } from './RulesForm'
import { SummaryView } from './SummaryView'

let client: CompareClient | null = null
function getClient(): CompareClient {
  client ??= createCompareClient()
  return client
}

type Outcome<T> = { inputs: string } & ({ status: 'pending' } | { status: 'done'; value: T } | { status: 'error'; message: string })

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function App() {
  const [delimiter, setDelimiter] = useState<ParseRules['delimiter']>('auto')
  const [files, setFiles] = useState<Record<Side, FileState>>({ old: { status: 'empty' }, new: { status: 'empty' } })
  // Bumped on every load so results computed from earlier files are recognisably stale.
  const [dataVersion, setDataVersion] = useState(0)
  const [keyRules, setKeyRules] = useState<KeyRules>({ columns: [], trim: true, caseInsensitive: false })
  const [valueRules, setValueRules] = useState<ValueRules>({ ignoredColumns: [], trim: false, caseInsensitive: [], numeric: {} })
  const [keyCheck, setKeyCheck] = useState<Outcome<KeyReport> | null>(null)
  const [comparison, setComparison] = useState<Outcome<CompareResult> | null>(null)
  const loadTokens = useRef<Record<Side, number>>({ old: 0, new: 0 })
  const latestKeyInputs = useRef('')
  const latestCompareInputs = useRef('')

  function load(side: Side, file: File, delim: ParseRules['delimiter']) {
    const token = ++loadTokens.current[side]
    const isCurrent = () => token === loadTokens.current[side]
    setFiles((prev) => ({ ...prev, [side]: { status: 'loading', file } }))
    setDataVersion((v) => v + 1)
    getClient()
      .call('parse', { side, file, rules: { delimiter: delim, trimHeaders: true } })
      .then((result) => {
        if (!isCurrent()) return
        const next: FileState = result.ok
          ? { status: 'ready', file, info: result.info }
          : { status: 'invalid', file, issues: result.issues, issueCount: result.issueCount }
        setFiles((prev) => ({ ...prev, [side]: next }))
        setDataVersion((v) => v + 1)
      })
      .catch((error: unknown) => {
        if (isCurrent()) setFiles((prev) => ({ ...prev, [side]: { status: 'failed', file, message: message(error) } }))
      })
  }

  function changeDelimiter(next: ParseRules['delimiter']) {
    setDelimiter(next)
    for (const side of ['old', 'new'] as const) {
      const state = files[side]
      if (state.status !== 'empty') load(side, state.file, next)
    }
  }

  const oldInfo = files.old.status === 'ready' ? files.old.info : null
  const newInfo = files.new.status === 'ready' ? files.new.info : null
  const schema = useMemo(
    () => (oldInfo && newInfo ? schemaDiff(oldInfo.headers, newInfo.headers) : null),
    [oldInfo, newInfo],
  )
  const effectiveKeyRules = useMemo(
    () => ({ ...keyRules, columns: keyRules.columns.filter((c) => schema?.shared.includes(c)) }),
    [keyRules, schema],
  )
  const keyInputs = JSON.stringify([dataVersion, effectiveKeyRules])
  const compareInputs = JSON.stringify([dataVersion, effectiveKeyRules, valueRules])
  const canCheckKeys = schema !== null && effectiveKeyRules.columns.length > 0

  useEffect(() => {
    latestKeyInputs.current = keyInputs
    if (!canCheckKeys) return
    const inputs = keyInputs
    getClient()
      .call('checkKeys', { rules: effectiveKeyRules })
      .then((value) => {
        if (latestKeyInputs.current === inputs) setKeyCheck({ inputs, status: 'done', value })
      })
      .catch((error: unknown) => {
        if (latestKeyInputs.current === inputs) setKeyCheck({ inputs, status: 'error', message: message(error) })
      })
  }, [keyInputs, canCheckKeys, effectiveKeyRules])

  function compare() {
    const inputs = compareInputs
    latestCompareInputs.current = inputs
    setComparison({ inputs, status: 'pending' })
    const profile: CompareProfile = {
      name: 'Unsaved',
      parse: { delimiter, trimHeaders: true },
      key: effectiveKeyRules,
      value: valueRules,
    }
    getClient()
      .call('compare', { profile })
      .then((value) => {
        if (latestCompareInputs.current === inputs) setComparison({ inputs, status: 'done', value })
      })
      .catch((error: unknown) => {
        if (latestCompareInputs.current === inputs) setComparison({ inputs, status: 'error', message: message(error) })
      })
  }

  const report = keyCheck?.inputs === keyInputs ? keyCheck : null
  const currentComparison = comparison?.inputs === compareInputs ? comparison : null

  return (
    <main>
      <header>
        <h1>CSV Diff</h1>
        <p className="muted">Files are read in your browser and never uploaded.</p>
        <label>
          Delimiter{' '}
          <select value={delimiter} onChange={(e) => changeDelimiter(e.target.value as ParseRules['delimiter'])}>
            <option value="auto">Detect automatically</option>
            <option value=",">Comma</option>
            <option value=";">Semicolon</option>
            <option value={'\t'}>Tab</option>
          </select>
        </label>{' '}
        <span className="muted">Headers are trimmed; a leading byte-order mark is ignored.</span>
      </header>

      <div className="files">
        <FilePanel title="Old file" state={files.old} onPick={(file) => load('old', file, delimiter)} />
        <FilePanel title="New file" state={files.new} onPick={(file) => load('new', file, delimiter)} />
      </div>

      {schema && (
        <section className="panel">
          <h2>Columns</h2>
          <p>
            {schema.shared.length} shared
            {schema.added.length > 0 && ` · new file only: ${schema.added.join(', ')}`}
            {schema.removed.length > 0 && ` · old file only: ${schema.removed.join(', ')}`}
          </p>

          <KeyRulesForm columns={schema.shared} rules={keyRules} onChange={setKeyRules} />
          {canCheckKeys && !report && <p className="muted">Checking keys…</p>}
          {report?.status === 'error' && <p className="error">{report.message}</p>}
          {report?.status === 'done' && (
            <>
              <p>
                {report.value.counts.matched} matched · {report.value.counts.added} only in new ·{' '}
                {report.value.counts.removed} only in old
              </p>
              <KeyProblemsList
                problems={report.value}
                ambiguousCount={report.value.counts.ambiguous}
                emptyKeyCount={report.value.counts.emptyKey}
              />
            </>
          )}

          <ValueRulesForm columns={schema.shared} rules={valueRules} onChange={setValueRules} />

          <button type="button" disabled={!canCheckKeys || currentComparison?.status === 'pending'} onClick={compare}>
            {currentComparison?.status === 'pending' ? 'Comparing…' : 'Compare'}
          </button>
          {comparison && !currentComparison && <span className="muted"> Files or rules changed since the last result.</span>}
          {currentComparison?.status === 'error' && <p className="error">{currentComparison.message}</p>}
        </section>
      )}

      {currentComparison?.status === 'done' && <SummaryView result={currentComparison.value} />}
    </main>
  )
}
