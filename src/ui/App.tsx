import { useEffect, useMemo, useRef, useState } from 'react'
import { schemaDiff } from '../engine/diff'
import type { CompareProfile, KeyRules, ParseRules, Side, ValueRules } from '../engine/types'
import { exportProfile, importProfile, missingColumns, ProfileError, profileFileName, readProfile, sameRules } from '../profiles/profile'
import { browserStorage, createProfileStore } from '../profiles/store'
import { CancelledError, createCompareClient } from '../worker/client'
import type { CompareResult, ExportFormat, KeyReport, Progress } from '../worker/protocol'
import { type Activity, ActivityBar, type Task } from './ActivityBar'
import { FilePanel, type FileState } from './FilePanel'
import { KeyProblemsList } from './KeyProblemsList'
import { ProfileBar, type ProfileMessage } from './ProfileBar'
import { KeyRulesForm, ValueRulesForm } from './RulesForm'
import { ResultsTabs } from './results/ResultsTabs'
import { SummaryView } from './SummaryView'

type Outcome<T> = { inputs: string } & ({ status: 'pending' } | { status: 'done'; value: T } | { status: 'error'; message: string })

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

function failIfLoaded(state: FileState, reason: string): FileState {
  return state.status === 'empty' ? state : { status: 'failed', file: state.file, message: `${reason}. Load the file again.` }
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
  const [profileStore] = useState(() => createProfileStore(browserStorage()))
  const [savedProfiles, setSavedProfiles] = useState(() => profileStore.list())
  const [profileName, setProfileName] = useState('')
  const [profileMessage, setProfileMessage] = useState<ProfileMessage | null>(null)
  const [activity, setActivity] = useState<Activity>({})
  const [exportError, setExportError] = useState<string | null>(null)
  const activityTokens = useRef<Partial<Record<Task, number>>>({})
  const [client] = useState(() =>
    createCompareClient((reason) => {
      setFiles((prev) => ({ old: failIfLoaded(prev.old, reason), new: failIfLoaded(prev.new, reason) }))
      setDataVersion((v) => v + 1)
    }),
  )
  useEffect(() => () => client.terminate(), [client])
  const loadTokens = useRef<Record<Side, number>>({ old: 0, new: 0 })
  const latestKeyInputs = useRef('')
  const latestCompareInputs = useRef('')

  // Only the latest run of a task may update or clear its progress. A task appears with its
  // first progress message; user-started tasks call show() to appear before that.
  function track(task: Task) {
    const token = (activityTokens.current[task] ?? 0) + 1
    activityTokens.current[task] = token
    const live = () => activityTokens.current[task] === token
    return {
      show: () => {
        if (live()) setActivity((a) => ({ ...a, [task]: a[task] ?? null }))
      },
      progress: (p: Progress) => {
        if (live()) setActivity((a) => ({ ...a, [task]: p }))
      },
      end: () => {
        if (!live()) return
        setActivity((a) => {
          const next = { ...a }
          delete next[task]
          return next
        })
      },
    }
  }

  function load(side: Side, file: File, delim: ParseRules['delimiter']) {
    const token = ++loadTokens.current[side]
    const isCurrent = () => token === loadTokens.current[side]
    const task = track(side)
    task.show()
    setFiles((prev) => ({ ...prev, [side]: { status: 'loading', file } }))
    setDataVersion((v) => v + 1)
    client
      .call('parse', { side, file, rules: { delimiter: delim, trimHeaders: true } }, task.progress)
      .then((result) => {
        if (!isCurrent()) return
        const next: FileState = result.ok
          ? { status: 'ready', file, info: result.info }
          : { status: 'invalid', file, issues: result.issues }
        setFiles((prev) => ({ ...prev, [side]: next }))
        setDataVersion((v) => v + 1)
      })
      .catch((error: unknown) => {
        if (isCurrent()) setFiles((prev) => ({ ...prev, [side]: { status: 'failed', file, message: message(error) } }))
      })
      .finally(task.end)
  }

  function changeDelimiter(next: ParseRules['delimiter']) {
    setDelimiter(next)
    for (const side of ['old', 'new'] as const) {
      const state = files[side]
      if (state.status !== 'empty') load(side, state.file, next)
    }
  }

  const currentProfile: CompareProfile = {
    name: profileName.trim(),
    parse: { delimiter, trimHeaders: true },
    key: keyRules,
    value: valueRules,
  }
  const savedVersion = savedProfiles.find((p) => p.name === currentProfile.name)
  const modified = savedVersion !== undefined && !sameRules(savedVersion, currentProfile)

  function validProfile(): CompareProfile | null {
    try {
      return readProfile(currentProfile)
    } catch (error) {
      if (!(error instanceof ProfileError)) throw error
      setProfileMessage({ kind: 'error', text: error.message })
      return null
    }
  }

  function applyProfile(profile: CompareProfile) {
    setProfileName(profile.name)
    setKeyRules(profile.key)
    setValueRules(profile.value)
    if (profile.parse.delimiter !== delimiter) changeDelimiter(profile.parse.delimiter)
  }

  function saveProfile() {
    const profile = validProfile()
    if (!profile) return
    setSavedProfiles(profileStore.save(profile))
    setProfileMessage({ kind: 'info', text: `Saved “${profile.name}”.` })
  }

  function exportCurrentProfile() {
    const profile = validProfile()
    if (!profile) return
    download(new Blob([exportProfile(profile)], { type: 'application/json' }), profileFileName(profile.name))
    setProfileMessage(null)
  }

  function importProfileFile(file: File) {
    file
      .text()
      .then((text) => {
        const profile = importProfile(text)
        applyProfile(profile)
        const clash = savedProfiles.find((p) => p.name === profile.name)
        setProfileMessage({
          kind: 'info',
          text:
            clash && !sameRules(clash, profile)
              ? `Applied “${profile.name}”. A different saved profile has this name; saving will replace it.`
              : `Applied “${profile.name}”. Save it to keep it in this browser.`,
        })
      })
      .catch((error: unknown) => setProfileMessage({ kind: 'error', text: `Could not import ${file.name}: ${message(error)}` }))
  }

  const oldInfo = files.old.status === 'ready' ? files.old.info : null
  const newInfo = files.new.status === 'ready' ? files.new.info : null
  const schema = useMemo(
    () => (oldInfo && newInfo ? schemaDiff(oldInfo.headers, newInfo.headers) : null),
    [oldInfo, newInfo],
  )
  // Never drop a missing key column silently: (warehouse, sku) reduced to (sku) matches different records.
  const missing = schema ? missingColumns(currentProfile, schema.shared) : { key: [], rules: [] }
  const missingKeyColumns = missing.key
  const keyInputs = JSON.stringify([dataVersion, keyRules])
  const compareInputs = JSON.stringify([dataVersion, keyRules, valueRules])
  const canCheckKeys = schema !== null && keyRules.columns.length > 0 && missingKeyColumns.length === 0

  useEffect(() => {
    latestKeyInputs.current = keyInputs
    if (!canCheckKeys) return
    const inputs = keyInputs
    const task = track('keys')
    client
      .call('checkKeys', { rules: keyRules }, task.progress)
      .then((value) => {
        if (latestKeyInputs.current === inputs) setKeyCheck({ inputs, status: 'done', value })
      })
      .catch((error: unknown) => {
        if (error instanceof CancelledError) return
        if (latestKeyInputs.current === inputs) setKeyCheck({ inputs, status: 'error', message: message(error) })
      })
      .finally(task.end)
  }, [client, keyInputs, canCheckKeys, keyRules])

  function compare() {
    const inputs = compareInputs
    latestCompareInputs.current = inputs
    setComparison({ inputs, status: 'pending' })
    const profile = { ...currentProfile, name: currentProfile.name || 'Unsaved' }
    const task = track('compare')
    task.show()
    setExportError(null)
    client
      .call('compare', { profile }, task.progress)
      .then((value) => {
        if (latestCompareInputs.current === inputs) setComparison({ inputs, status: 'done', value })
      })
      .catch((error: unknown) => {
        if (error instanceof CancelledError) return
        if (latestCompareInputs.current === inputs) setComparison({ inputs, status: 'error', message: message(error) })
      })
      .finally(task.end)
  }

  function exportResult(result: CompareResult, format: ExportFormat) {
    const task = track('export')
    task.show()
    setExportError(null)
    const base = currentProfile.name ? profileFileName(currentProfile.name).replace('.csv-diff-profile.json', '') : 'csv-diff'
    client
      .call('export', { resultId: result.resultId, format }, task.progress)
      .then((blob) => download(blob, format === 'csv' ? `${base}-changes.csv` : `${base}-report.json`))
      .catch((error: unknown) => {
        if (!(error instanceof CancelledError)) setExportError(message(error))
      })
      .finally(task.end)
  }

  // The worker is stopped, so everything it held is gone: files mid-read must be picked
  // again, files already read are read again, and a running comparison is abandoned.
  function cancel() {
    client.cancel()
    activityTokens.current = {}
    setActivity({})
    for (const side of ['old', 'new'] as const) {
      const state = files[side]
      if (state.status === 'loading') {
        loadTokens.current[side]++
        setFiles((prev) => ({
          ...prev,
          [side]: { status: 'failed', file: state.file, message: 'Reading cancelled. Pick the file again.' },
        }))
      } else if (state.status === 'ready') {
        load(side, state.file, delimiter)
      }
    }
    setComparison((c) => (c?.status === 'pending' ? { inputs: c.inputs, status: 'error', message: 'Comparison cancelled.' } : c))
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

      <ActivityBar activity={activity} onCancel={cancel} />

      <ProfileBar
        name={profileName}
        onNameChange={setProfileName}
        saved={savedProfiles}
        modified={modified}
        canSave={currentProfile.name !== '' && keyRules.columns.length > 0}
        message={profileMessage}
        storeProblem={profileStore.problem}
        onSave={saveProfile}
        onApply={(profile) => {
          applyProfile(profile)
          setProfileMessage({ kind: 'info', text: `Applied “${profile.name}”.` })
        }}
        onDelete={(name) => {
          setSavedProfiles(profileStore.remove(name))
          setProfileMessage({ kind: 'info', text: `Deleted “${name}”.` })
        }}
        onExport={exportCurrentProfile}
        onImport={importProfileFile}
      />

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
          {missingKeyColumns.length > 0 && (
            <div className="error">
              Key column{missingKeyColumns.length === 1 ? '' : 's'} {missingKeyColumns.join(', ')} missing from the loaded
              files. Comparing without {missingKeyColumns.length === 1 ? 'it' : 'them'} would match different records.{' '}
              <button
                type="button"
                onClick={() => setKeyRules({ ...keyRules, columns: keyRules.columns.filter((c) => schema.shared.includes(c)) })}
              >
                Remove from key
              </button>
            </div>
          )}
          {canCheckKeys && !report && <p className="muted">Checking keys…</p>}
          {report?.status === 'error' && <p className="error">{report.message}</p>}
          {report?.status === 'done' && (
            <>
              <p>
                {report.value.counts.matched} matched · {report.value.counts.added} only in new ·{' '}
                {report.value.counts.removed} only in old
              </p>
              <KeyProblemsList problems={report.value} />
            </>
          )}

          <ValueRulesForm columns={schema.shared} rules={valueRules} onChange={setValueRules} />
          {missing.rules.length > 0 && (
            <p className="warning">
              Value rules name column{missing.rules.length === 1 ? '' : 's'} not in these files, so{' '}
              {missing.rules.length === 1 ? 'it has' : 'they have'} no effect: {missing.rules.join(', ')}.
            </p>
          )}

          <button type="button" disabled={!canCheckKeys || currentComparison?.status === 'pending'} onClick={compare}>
            {currentComparison?.status === 'pending' ? 'Comparing…' : 'Compare'}
          </button>
          {comparison && !currentComparison && <span className="muted"> Files or rules changed since the last result.</span>}
          {currentComparison?.status === 'error' && <p className="error">{currentComparison.message}</p>}
        </section>
      )}

      {currentComparison?.status === 'done' && oldInfo && newInfo && (
        <>
          <SummaryView
            result={currentComparison.value}
            exporting={'export' in activity}
            exportError={exportError}
            onExport={(format) => exportResult(currentComparison.value, format)}
          />
          <ResultsTabs
            client={client}
            result={currentComparison.value}
            oldHeaders={oldInfo.headers}
            newHeaders={newInfo.headers}
          />
        </>
      )}
    </main>
  )
}
