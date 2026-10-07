import {
  ArrowRight,
  Check,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { schemaDiff } from '../engine/diff'
import type { CompareProfile, KeyRules, ParseRules, Side, ValueRules } from '../engine/types'
import {
  exportProfile,
  importProfile,
  missingColumns,
  ProfileError,
  profileFileName,
  readProfile,
  sameRules,
} from '../profiles/profile'
import { browserStorage, createProfileStore } from '../profiles/store'
import { CancelledError, createCompareClient } from '../worker/client'
import type { CompareResult, ExportFormat, KeyReport, Progress } from '../worker/protocol'
import { type Activity, PHASE_LABELS, TASK_LABELS, type Task } from './activity'
import { ActivityBar } from './ActivityBar'
import { fileLabel, type FileState, sheetOf } from './file-state'
import { valueRulesLine } from './rules-summary'
import { FilePanel } from './FilePanel'
import { KeyProblemsList } from './KeyProblemsList'
import { ProfileBar, type ProfileMessage } from './ProfileBar'
import { KeyRulesForm, ValueRulesForm } from './RulesForm'
import { ResultsTabs } from './results/ResultsTabs'
import { SummaryView } from './SummaryView'
import { count, counted } from './format'
import { Select } from './Select'

type Step = 'files' | 'rules' | 'results'

type Outcome<T> = { inputs: string } & (
  { status: 'pending' } | { status: 'done'; value: T } | { status: 'error'; message: string }
)

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
  return state.status === 'empty'
    ? state
    : { status: 'failed', file: state.file, message: `${reason}. Load the file again.`, sheet: sheetOf(state) }
}

const EXPORT_NAMES: Record<ExportFormat, string> = { csv: 'changes.csv', json: 'report.json', xlsx: 'report.xlsx' }

export function App() {
  const [requestedStep, setStep] = useState<Step>('files')
  const [delimiter, setDelimiter] = useState<ParseRules['delimiter']>('auto')
  const [files, setFiles] = useState<Record<Side, FileState>>({ old: { status: 'empty' }, new: { status: 'empty' } })
  // Bumped on every load so results computed from earlier files are recognisably stale.
  const [dataVersion, setDataVersion] = useState(0)
  const [keyRules, setKeyRules] = useState<KeyRules>({ columns: [], trim: true, caseInsensitive: false })
  const [valueRules, setValueRules] = useState<ValueRules>({
    ignoredColumns: [],
    trim: false,
    caseInsensitive: [],
    numeric: {},
  })
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

  function load(side: Side, file: File, delim: ParseRules['delimiter'], sheet?: string) {
    setStep('files')
    const token = ++loadTokens.current[side]
    const isCurrent = () => token === loadTokens.current[side]
    const task = track(side)
    task.show()
    setFiles((prev) => ({ ...prev, [side]: { status: 'loading', file, sheet } }))
    setDataVersion((v) => v + 1)
    client
      .call('parse', { side, file, sheet, rules: { delimiter: delim, trimHeaders: true } }, task.progress)
      .then((result) => {
        if (!isCurrent()) return
        const next: FileState = result.ok
          ? { status: 'ready', file, info: result.info }
          : { status: 'invalid', file, issues: result.issues, format: result.format }
        setFiles((prev) => ({ ...prev, [side]: next }))
        setDataVersion((v) => v + 1)
      })
      .catch((error: unknown) => {
        if (isCurrent()) setFiles((prev) => ({ ...prev, [side]: { status: 'failed', file, message: message(error), sheet } }))
      })
      .finally(task.end)
  }

  function changeDelimiter(next: ParseRules['delimiter']) {
    setDelimiter(next)
    for (const side of ['old', 'new'] as const) {
      const state = files[side]
      if (state.status === 'empty' || (state.status === 'ready' && state.info.format.kind === 'xlsx')) continue
      load(side, state.file, next, sheetOf(state))
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
      .catch((error: unknown) =>
        setProfileMessage({ kind: 'error', text: `Could not import ${file.name}: ${message(error)}` }),
      )
  }

  const isWorkbook = (state: FileState) => state.status === 'ready' && state.info.format.kind === 'xlsx'
  const bothWorkbooks = isWorkbook(files.old) && isWorkbook(files.new)
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
        if (latestCompareInputs.current === inputs) {
          setComparison({ inputs, status: 'done', value })
          setStep('results')
        }
      })
      .catch((error: unknown) => {
        if (error instanceof CancelledError) return
        if (latestCompareInputs.current === inputs) setComparison({ inputs, status: 'error', message: message(error) })
      })
      .finally(task.end)
  }

  function exportResult(result: CompareResult, format: ExportFormat, escapeFormulae: boolean) {
    const task = track('export')
    task.show()
    setExportError(null)
    const base = currentProfile.name
      ? profileFileName(currentProfile.name).replace('.csv-diff-profile.json', '')
      : 'csv-diff'
    client
      .call('export', { resultId: result.resultId, format, escapeFormulae }, task.progress)
      .then((blob) => download(blob, `${base}-${EXPORT_NAMES[format]}`))
      .catch((error: unknown) => {
        if (!(error instanceof CancelledError)) setExportError(message(error))
      })
      .finally(task.end)
  }

  // The worker is stopped, so everything it held is gone. Nothing restarts on its own:
  // re-reading straight away would make Cancel look like it did nothing.
  function cancel() {
    setStep('files')
    client.cancel()
    activityTokens.current = {}
    setActivity({})
    for (const side of ['old', 'new'] as const) {
      const state = files[side]
      if (state.status !== 'loading' && state.status !== 'ready') continue
      loadTokens.current[side]++
      const text = state.status === 'loading' ? 'Reading cancelled.' : 'Cancelled, so this file needs reading again.'
      setFiles((prev) => ({ ...prev, [side]: { status: 'failed', file: state.file, message: text, sheet: sheetOf(state) } }))
    }
    setComparison((c) =>
      c?.status === 'pending' ? { inputs: c.inputs, status: 'error', message: 'Comparison cancelled.' } : c,
    )
  }

  const report = keyCheck?.inputs === keyInputs ? keyCheck : null
  const currentComparison = comparison?.inputs === compareInputs ? comparison : null
  const step = !schema
    ? 'files'
    : requestedStep === 'results' && currentComparison?.status !== 'done'
      ? 'rules'
      : requestedStep
  const stepHeading = useRef<HTMLHeadingElement>(null)
  const previousStep = useRef(step)

  useEffect(() => {
    latestCompareInputs.current = compareInputs
  }, [compareInputs])

  useEffect(() => {
    if (previousStep.current === step) return
    previousStep.current = step
    stepHeading.current?.focus({ preventScroll: true })
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [step])

  return (
    <>
      <main id="workspace" tabIndex={-1} className={step === 'results' ? 'workspace results-workspace' : 'workspace'}>
        <nav className="workflow-nav" aria-label="Comparison workflow">
          {(['files', 'rules', 'results'] as const).map((item, index) => (
            <button
              key={item}
              type="button"
              aria-current={step === item ? 'step' : undefined}
              className={step === item ? 'current' : ''}
              disabled={item === 'rules' ? !schema : item === 'results' ? currentComparison?.status !== 'done' : false}
              onClick={() => setStep(item)}
            >
              <span className="step-number">
                {item === 'files' && schema ? <Check size={14} aria-hidden="true" /> : index + 1}
              </span>
              {item === 'files' ? 'Files' : item === 'rules' ? 'Match' : 'Results'}
            </button>
          ))}
        </nav>
        <ActivityBar activity={activity} onCancel={cancel} taskLabels={TASK_LABELS} phaseLabels={PHASE_LABELS} />
        <div className="workspace-surface">
          <div className="workspace-heading">
            <div>
              <h1 ref={stepHeading} tabIndex={-1}>
                {step === 'files' ? 'Compare CSV files' : step === 'rules' ? 'Match records' : 'Comparison results'}
              </h1>
              <p className="muted">
                {step === 'files' ? 'Add your baseline and updated export.'
                  : step === 'rules' ? 'Choose the columns that identify the same record in both files.'
                  : `${fileLabel(files.old)} → ${fileLabel(files.new)}`}
              </p>
            </div>
            {step === 'results' && <button type="button" onClick={() => setStep('rules')}>Edit comparison</button>}
          </div>
          {step === 'files' && (
            <section id="files" aria-label="Source files">
              <div className="files">
                {(['old', 'new'] as const).map((side) => (
                  <FilePanel
                    key={side}
                    title={side === 'old' ? 'Old file' : 'New file'}
                    state={files[side]}
                    onPick={(file, sheet) => load(side, file, delimiter, sheet)}
                    onPickSheet={(sheet) => {
                      const state = files[side]
                      if (state.status !== 'empty') load(side, state.file, delimiter, sheet)
                    }}
                    fetchIssues={(offset, limit) => client.call('getIssues', { side, offset, limit })}
                  />
                ))}
              </div>

              {!bothWorkbooks && (
              <div className="parse-toolbar">
                <span>CSV delimiter</span>
                <Select<ParseRules['delimiter']>
                  label="CSV delimiter"
                  value={delimiter}
                  onChange={changeDelimiter}
                  options={[
                    { value: 'auto', label: 'Detect automatically' },
                    { value: ',', label: 'Comma' },
                    { value: ';', label: 'Semicolon' },
                    { value: '\t', label: 'Tab' },
                  ]}
                />
              </div>
              )}
            </section>
          )}
          {step === 'rules' && schema && (
              <section id="rules" className="rules-panel" aria-label="Comparison rules">
                {schema.shared.length === 0 && (
                  <p className="warning">No shared columns. Go back and choose files with at least one matching header.</p>
                )}
                <details className={`column-differences ${schema.added.length + schema.removed.length > 0 ? 'warning' : 'note'}`}>
                  <summary>
                    Columns: {count(schema.shared.length)} shared · {count(schema.added.length)} new-only ·{' '}
                    {count(schema.removed.length)} old-only
                  </summary>
                  {schema.added.length + schema.removed.length === 0 ? (
                    <p>Both files have the same columns.</p>
                  ) : (
                    <>
                      <p>Only shared columns are compared; the others are left out.</p>
                      {schema.added.length > 0 && <p>New file only: {schema.added.join(', ')}</p>}
                      {schema.removed.length > 0 && <p>Old file only: {schema.removed.join(', ')}</p>}
                    </>
                  )}
                </details>
                <KeyRulesForm columns={schema.shared} rules={keyRules} onChange={setKeyRules} />
                {missingKeyColumns.length > 0 && (
                  <div className="error">
                    Key column{missingKeyColumns.length === 1 ? '' : 's'} {missingKeyColumns.join(', ')} missing from
                    the loaded files. Comparing without {missingKeyColumns.length === 1 ? 'it' : 'them'} would match
                    different records.{' '}
                    <button
                      type="button"
                      onClick={() =>
                        setKeyRules({ ...keyRules, columns: keyRules.columns.filter((c) => schema.shared.includes(c)) })
                      }
                    >
                      Remove from key
                    </button>
                  </div>
                )}
                {canCheckKeys && !report && <p className="muted">Checking keys…</p>}
                {report?.status === 'error' && <p className="error">{report.message}</p>}
                {report?.status === 'done' && (
                  <>
                    <p className="key-status" role="status">
                      {report.value.counts.matched} matched · {report.value.counts.added} only in new ·{' '}
                      {report.value.counts.removed} only in old
                    </p>
                    {(report.value.ambiguous.total > 0 || report.value.emptyKey.total > 0) && (
                      <details className="key-problems">
                        <summary>
                          Review key problems: {counted(report.value.ambiguous.total, 'ambiguous key')} ·{' '}
                          {counted(report.value.emptyKey.total, 'empty-key record')}
                        </summary>
                        <KeyProblemsList problems={report.value} />
                      </details>
                    )}
                  </>
                )}

                <details className="value-disclosure">
                  <summary>
                    Value comparison{' '}
                    <span className="muted">{valueRulesLine(valueRules)}</span>
                  </summary>
                  <ValueRulesForm columns={schema.shared} rules={valueRules} onChange={setValueRules} />
                </details>
                {missing.rules.length > 0 && (
                  <p className="warning">
                    Value rules name column{missing.rules.length === 1 ? '' : 's'} not in these files, so{' '}
                    {missing.rules.length === 1 ? 'it has' : 'they have'} no effect: {missing.rules.join(', ')}.
                  </p>
                )}

                {currentComparison?.status === 'error' && (
                  <p className="error" role="alert">
                    {currentComparison.message}
                  </p>
                )}
              </section>
            )}
          {step === 'results' && currentComparison?.status === 'done' && oldInfo && newInfo && (
            <section id="results" aria-label="Comparison results">
              <SummaryView
                key={currentComparison.value.resultId}
                result={currentComparison.value}
                sources={`${fileLabel(files.old)} → ${fileLabel(files.new)}`}
                exporting={'export' in activity}
                exportError={exportError}
                onExport={(format, escape) => exportResult(currentComparison.value, format, escape)}
              />
              <ResultsTabs
                key={currentComparison.value.resultId}
                client={client}
                result={currentComparison.value}
                oldHeaders={oldInfo.headers}
                newHeaders={newInfo.headers}
              />
            </section>
          )}
          {step !== 'results' && (
            <>
              <details className="profile-disclosure">
                <summary>
                  Saved profiles
                  {profileName && <span className="muted">{profileName}{modified ? ' (modified)' : ''}</span>}
                </summary>
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
              </details>
              <div className="step-actions">
                {step === 'files' ? (
                  <>
                    <span className="note" role="status">{schema ? 'Both files ready' : 'Add both files to continue'}</span>
                    <button className="primary" type="button" disabled={!schema} onClick={() => setStep('rules')}>
                      Choose matching columns <ArrowRight size={16} aria-hidden="true" />
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => setStep('files')}>Back to files</button>
                    <span className="note" role="status">
                      {!canCheckKeys ? 'Select a shared key column to continue.'
                        : comparison && !currentComparison ? 'Setup changed. Compare again to update results.' : ''}
                    </span>
                    <button
                      className="primary"
                      type="button"
                      disabled={!canCheckKeys || currentComparison?.status === 'pending'}
                      onClick={compare}
                    >
                      {currentComparison?.status === 'pending' ? 'Comparing…' : 'Compare files'}
                      <ArrowRight size={16} aria-hidden="true" />
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </>
  )
}
