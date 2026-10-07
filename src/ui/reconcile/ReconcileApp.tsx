import { ArrowRight, Check, FlaskConical } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Layout } from '../../engine/parse'
import { contextIssues } from '../../reconciliation/normalize'
import { DEFAULT_MATCHING, type MatchingRules, RECON_SIDES, type ReconSide, type SessionContext, type SideMapping } from '../../reconciliation/types'
import { CancelledError, createReconcileClient } from '../../worker/client'
import type { MatchSummary, NormalizeResult, ReconPhase, ReconProgress, SideSummary, SourceInfo } from '../../worker/reconcile-protocol'
import type { Activity } from '../activity'
import { ActivityBar } from '../ActivityBar'
import { WORKSPACE_IDS } from '../mode'
import { fileLabel, type FileState } from '../file-state'
import { FilePanel } from '../FilePanel'
import { count, counted, formatValue } from '../format'
import { Select } from '../Select'
import { emptyDraft, type MappingDraft, toMapping } from './mapping-draft'
import { MappingForm } from './MappingForm'
import { NumberField } from './NumberField'
import { type Formats, locationText, SIDE_LABELS } from './location'
import { ReviewView } from './ReviewView'

type Step = 'files' | 'map' | 'review'

type Task = ReconSide | 'normalize' | 'match'

const TASK_LABELS: Record<Task, string> = {
  bank: 'Reading bank statement',
  books: 'Reading books',
  normalize: 'Checking the mapping',
  match: 'Finding suggestions',
}

const PHASE_LABELS: Record<ReconPhase, string> = {
  parse: 'parsing records',
  normalize: 'reading dates and amounts',
  match: 'searching for pairs',
}

const SOURCE_TITLES: Record<ReconSide, { title: string; badge: string; caption: string }> = {
  bank: { title: 'Bank statement', badge: 'B', caption: 'From the bank' },
  books: { title: 'Books', badge: 'L', caption: 'Your ledger' },
}

type Outcome<T> = { inputs: string } & ({ status: 'pending' } | { status: 'done'; value: T } | { status: 'error'; message: string })

type SourceState = FileState<SourceInfo>

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failIfLoaded(state: SourceState, reason: string): SourceState {
  if (state.status === 'loading' || state.status === 'ready') {
    const sheet = state.status === 'ready' && state.info.format.kind === 'xlsx' ? state.info.format.sheet : state.status === 'loading' ? state.sheet : undefined
    return { status: 'failed', file: state.file, message: reason, sheet }
  }
  return state
}

function SkippedRecords({ info }: { info: SourceInfo }) {
  const { before, after } = info.skipped
  if (before.total + after.total === 0) return null
  return (
    <details className="preview-disclosure">
      <summary>
        Skipped {counted(before.total, 'record')} above the header and {counted(after.total, 'record')} at the end
      </summary>
      <p className="note">Skipped records are not read as transactions or balances.</p>
      {before.items.length > 0 && <pre className="skipped">{before.items.join('\n')}</pre>}
      {after.items.length > 0 && <pre className="skipped">{after.items.join('\n')}</pre>}
    </details>
  )
}

function SideCheck({ side, summary, formats }: { side: ReconSide; summary: SideSummary; formats: Formats }) {
  return (
    <div className="side-check">
      <h3>{SIDE_LABELS[side]}</h3>
      <p className="key-status">
        {counted(summary.rows, 'row')}: {count(summary.valid)} valid ({count(summary.moneyIn)} money in, {count(summary.moneyOut)} money out) ·{' '}
        {count(summary.zero)} zero · {counted(summary.problemRows, 'row')} with problems
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Date as written</th>
              <th>Amount as written</th>
              <th>Date</th>
              <th>Amount</th>
              <th>Direction</th>
            </tr>
          </thead>
          <tbody>
            {summary.sample.map((row) => (
              <tr key={row.recordNumber} className={row.problems.length > 0 ? 'problem' : ''}>
                <td>{locationText(row, formats)}</td>
                <td className="mono">{formatValue(row.original.date)}</td>
                <td className="mono">{row.original.amount.map(formatValue).join(' / ')}</td>
                {row.normalized ? (
                  <>
                    <td className="mono">{row.normalized.date}</td>
                    <td className="mono">{row.normalized.amount}</td>
                    <td>{row.normalized.direction === 'in' ? 'Money in' : 'Money out'}</td>
                  </>
                ) : (
                  <td colSpan={3}>{row.zero ? 'Zero amount: kept out of matching' : row.problems.join('; ')}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span className="metric-label">{label}</span>
    </div>
  )
}

export function ReconcileApp() {
  const [requestedStep, setStep] = useState<Step>('files')
  const [files, setFiles] = useState<Record<ReconSide, SourceState>>({ bank: { status: 'empty' }, books: { status: 'empty' } })
  const [drafts, setDrafts] = useState<Record<ReconSide, MappingDraft>>({ bank: emptyDraft(), books: emptyDraft() })
  const [context, setContext] = useState<SessionContext>({ account: '', currency: '', minorUnits: 2 })
  const [rules, setRules] = useState<MatchingRules>(DEFAULT_MATCHING)
  const [dataVersion, setDataVersion] = useState(0)
  const [check, setCheck] = useState<Outcome<NormalizeResult> | null>(null)
  const [review, setReview] = useState<Outcome<MatchSummary> | null>(null)
  const [activity, setActivity] = useState<Activity<Task, ReconPhase>>({})
  const activityTokens = useRef<Partial<Record<Task, number>>>({})
  const loadTokens = useRef<Record<ReconSide, number>>({ bank: 0, books: 0 })
  const [client] = useState(() =>
    createReconcileClient((reason) => {
      setFiles((prev) => ({ bank: failIfLoaded(prev.bank, reason), books: failIfLoaded(prev.books, reason) }))
      setDataVersion((v) => v + 1)
    }),
  )
  useEffect(() => () => client.terminate(), [client])

  function track(task: Task) {
    const token = (activityTokens.current[task] ?? 0) + 1
    activityTokens.current[task] = token
    const live = () => activityTokens.current[task] === token
    return {
      show: () => {
        if (live()) setActivity((a) => ({ ...a, [task]: a[task] ?? null }))
      },
      progress: (p: ReconProgress) => {
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

  function load(side: ReconSide, file: File, draft: MappingDraft, sheet?: string) {
    setStep('files')
    const token = ++loadTokens.current[side]
    const isCurrent = () => token === loadTokens.current[side]
    const task = track(side)
    task.show()
    setFiles((prev) => ({ ...prev, [side]: { status: 'loading', file, sheet } }))
    setDataVersion((v) => v + 1)
    client
      .call('parse', { side, file, sheet, delimiter: draft.delimiter, layout: draft.layout }, task.progress)
      .then((result) => {
        if (!isCurrent()) return
        const next: SourceState = result.ok
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

  function sheetOf(state: SourceState): string | undefined {
    if (state.status === 'ready' && state.info.format.kind === 'xlsx') return state.info.format.sheet
    if (state.status === 'invalid' && state.format?.kind === 'xlsx') return state.format.sheet
    return undefined
  }

  // Delimiter and layout decide how the file is read, so changing them reads it again.
  function changeReading(side: ReconSide, change: Partial<Pick<MappingDraft, 'delimiter'>> & { layout?: Layout }) {
    const draft = { ...drafts[side], ...change }
    setDrafts((prev) => ({ ...prev, [side]: draft }))
    const state = files[side]
    if (state.status !== 'empty') load(side, state.file, draft, sheetOf(state))
  }

  const headers: Record<ReconSide, string[] | null> = {
    bank: files.bank.status === 'ready' ? files.bank.info.headers : null,
    books: files.books.status === 'ready' ? files.books.info.headers : null,
  }
  const formats: Formats = {
    bank: files.bank.status === 'ready' ? files.bank.info.format : undefined,
    books: files.books.status === 'ready' ? files.books.info.format : undefined,
  }
  const bothReady = headers.bank !== null && headers.books !== null
  const outcomes = {
    bank: toMapping(drafts.bank, headers.bank ?? []),
    books: toMapping(drafts.books, headers.books ?? []),
  }
  const sessionIssues = contextIssues(context)
  const mappings: Record<ReconSide, SideMapping> | null =
    outcomes.bank.ok && outcomes.books.ok ? { bank: outcomes.bank.mapping, books: outcomes.books.mapping } : null
  const ready = bothReady && mappings !== null && sessionIssues.length === 0
  const checkInputs = JSON.stringify({ dataVersion, context, mappings })
  const reviewInputs = JSON.stringify({ checkInputs, rules })
  const currentCheck = check?.inputs === checkInputs ? check : null
  const currentReview = review?.inputs === reviewInputs ? review : null

  const step: Step = !bothReady ? 'files' : requestedStep === 'review' && currentReview?.status !== 'done' ? 'map' : requestedStep
  const stepHeading = useRef<HTMLHeadingElement>(null)
  const previousStep = useRef(step)
  useEffect(() => {
    if (previousStep.current === step) return
    previousStep.current = step
    stepHeading.current?.focus({ preventScroll: true })
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [step])

  async function normalize(inputs: string): Promise<NormalizeResult | null> {
    if (!mappings) return null
    const task = track('normalize')
    task.show()
    // A new normalization starts a new revision in the worker, so older suggestions are gone.
    setReview(null)
    setCheck({ inputs, status: 'pending' })
    try {
      const value = await client.call('normalize', { context, mappings }, task.progress)
      setCheck({ inputs, status: 'done', value })
      return value
    } catch (error) {
      setCheck({ inputs, status: 'error', message: error instanceof CancelledError ? 'Cancelled.' : message(error) })
      return null
    } finally {
      task.end()
    }
  }

  async function findSuggestions() {
    const inputs = reviewInputs
    const normalized = await normalize(checkInputs)
    if (!normalized?.ok) return
    const task = track('match')
    task.show()
    setReview({ inputs, status: 'pending' })
    try {
      const value = await client.call('match', { revision: normalized.revision, rules }, task.progress)
      setReview({ inputs, status: 'done', value })
      setStep('review')
    } catch (error) {
      setReview({ inputs, status: 'error', message: error instanceof CancelledError ? 'Cancelled.' : message(error) })
    } finally {
      task.end()
    }
  }

  function cancel() {
    client.cancel()
    activityTokens.current = {}
    setActivity({})
    setFiles((prev) => ({ bank: failIfLoaded(prev.bank, 'Cancelled.'), books: failIfLoaded(prev.books, 'Cancelled.') }))
    setDataVersion((v) => v + 1)
  }

  const summary = currentReview?.status === 'done' ? currentReview.value : null
  const busy = currentCheck?.status === 'pending' || currentReview?.status === 'pending'

  return (
    <main id={WORKSPACE_IDS.reconcile} tabIndex={-1} className={step === 'review' ? 'workspace results-workspace' : 'workspace'}>
      <nav className="workflow-nav" aria-label="Reconciliation workflow">
        {(['files', 'map', 'review'] as const).map((item, index) => (
          <button
            key={item}
            type="button"
            aria-current={step === item ? 'step' : undefined}
            className={step === item ? 'current' : ''}
            disabled={item === 'map' ? !bothReady : item === 'review' ? currentReview?.status !== 'done' : false}
            onClick={() => setStep(item)}
          >
            <span className="step-number">{item === 'files' && bothReady ? <Check size={14} aria-hidden="true" /> : index + 1}</span>
            {item === 'files' ? 'Files' : item === 'map' ? 'Map' : 'Review'}
          </button>
        ))}
      </nav>
      <ActivityBar activity={activity} onCancel={cancel} taskLabels={TASK_LABELS} phaseLabels={PHASE_LABELS} />
      <div className="workspace-surface">
        <p className="experimental-note">
          <FlaskConical size={16} aria-hidden="true" /> Experimental and suggestion-only. Nothing is confirmed or saved, and nothing here shows
          that an account is reconciled.
        </p>
        <div className="workspace-heading">
          <div>
            <h1 ref={stepHeading} tabIndex={-1}>
              {step === 'files' ? 'Reconcile a bank statement' : step === 'map' ? 'Map dates and amounts' : 'Suggested pairs'}
            </h1>
            <p className="muted">
              {step === 'files'
                ? 'Add the bank statement and your books for the same account and period.'
                : step === 'map'
                  ? 'Tell the tool how each file writes dates, amounts and references.'
                  : `${fileLabel(files.bank)} ↔ ${fileLabel(files.books)}`}
            </p>
          </div>
          {step === 'review' && (
            <button type="button" onClick={() => setStep('map')}>
              Edit mapping
            </button>
          )}
        </div>

        {step === 'files' && (
          <section aria-label="Source files">
            <div className="files">
              {RECON_SIDES.map((side) => {
                const state = files[side]
                const draft = drafts[side]
                return (
                  <FilePanel
                    key={side}
                    {...SOURCE_TITLES[side]}
                    state={state}
                    onPick={(file, sheet) => load(side, file, draft, sheet)}
                    onPickSheet={(sheet) => {
                      if (state.status !== 'empty') load(side, state.file, draft, sheet)
                    }}
                    fetchIssues={(offset, limit) => client.call('getIssues', { side, offset, limit })}
                  >
                    <div className="layout-fields">
                      <NumberField
                        label="Header is record"
                        value={draft.layout.headerRecord}
                        min={1}
                        onCommit={(headerRecord) => changeReading(side, { layout: { ...draft.layout, headerRecord } })}
                      />
                      <NumberField
                        label="Skip records at the end"
                        value={draft.layout.skipTrailing}
                        min={0}
                        onCommit={(skipTrailing) => changeReading(side, { layout: { ...draft.layout, skipTrailing } })}
                      />
                      <div className="field">
                        <span>CSV delimiter</span>
                        <Select<MappingDraft['delimiter']>
                          label={`${SOURCE_TITLES[side].title} CSV delimiter`}
                          value={draft.delimiter}
                          onChange={(delimiter) => changeReading(side, { delimiter })}
                          options={[
                            { value: 'auto', label: 'Detect automatically' },
                            { value: ',', label: 'Comma' },
                            { value: ';', label: 'Semicolon' },
                            { value: '\t', label: 'Tab' },
                          ]}
                        />
                      </div>
                    </div>
                    <p className="note">Records are counted without blank lines. Use these when account details sit above the table or totals below it.</p>
                    {state.status === 'ready' && <SkippedRecords info={state.info} />}
                  </FilePanel>
                )
              })}
            </div>
          </section>
        )}

        {step === 'map' && headers.bank && headers.books && (
          <section aria-label="Mapping" className="rules-panel">
            <fieldset className="panel session-fields">
              <legend>Account</legend>
              <label className="field">
                <span>Account name</span>
                <input type="text" value={context.account} onChange={(e) => setContext({ ...context, account: e.target.value })} />
              </label>
              <label className="field">
                <span>Currency</span>
                <input type="text" value={context.currency} placeholder="INR" onChange={(e) => setContext({ ...context, currency: e.target.value.toUpperCase() })} />
              </label>
              <NumberField label="Decimal places" value={context.minorUnits} min={0} max={4} onCommit={(minorUnits) => setContext({ ...context, minorUnits })} />
              <p className="note">
                You state these; the files are not checked against them. Both files must be for this one account and currency.
              </p>
              {sessionIssues.length > 0 && (
                <ul className="mapping-issues">
                  {sessionIssues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              )}
            </fieldset>
            <div className="files">
              {RECON_SIDES.map((side) => {
                const outcome = outcomes[side]
                return (
                  <MappingForm
                    key={side}
                    title={SOURCE_TITLES[side].title}
                    headers={headers[side] ?? []}
                    draft={drafts[side]}
                    issues={outcome.ok ? [] : outcome.issues}
                    onChange={(draft) => setDrafts((prev) => ({ ...prev, [side]: draft }))}
                  />
                )
              })}
            </div>
            <fieldset className="panel matching-fields">
              <legend>Matching</legend>
              <p className="note">Amounts must match exactly, with the same cash direction. Amount tolerance is not available yet.</p>
              <NumberField label="Bank date up to this many days before books" value={rules.bankDaysBefore} min={0} max={366} onCommit={(bankDaysBefore) => setRules({ ...rules, bankDaysBefore })} />
              <NumberField label="Bank date up to this many days after books" value={rules.bankDaysAfter} min={0} max={366} onCommit={(bankDaysAfter) => setRules({ ...rules, bankDaysAfter })} />
              <label className="choice">
                <input
                  type="checkbox"
                  checked={rules.referencesShared}
                  disabled={!drafts.bank.reference || !drafts.books.reference}
                  onChange={(e) => setRules({ ...rules, referencesShared: e.target.checked })}
                />{' '}
                Both reference columns hold the same identifier (for example a cheque number)
              </label>
              <label className="choice">
                <input
                  type="checkbox"
                  checked={rules.referenceCaseInsensitive}
                  disabled={!rules.referencesShared}
                  onChange={(e) => setRules({ ...rules, referenceCaseInsensitive: e.target.checked })}
                />{' '}
                Ignore case when comparing references
              </label>
              <p className="note">
                When references are compared, matching ones are listed first and differing ones are not suggested. Otherwise references are shown
                for context only.
              </p>
            </fieldset>

            <div className="row">
              <button type="button" disabled={!ready || busy} onClick={() => void normalize(checkInputs)}>
                Check mapping
              </button>
              {check && !currentCheck && <span className="note">The mapping changed; check it again.</span>}
            </div>
            {currentCheck?.status === 'error' && <p className="error" role="alert">{currentCheck.message}</p>}
            {currentCheck?.status === 'done' && !currentCheck.value.ok && (
              <ul className="error" role="alert">
                {currentCheck.value.issues.map((issue) => (
                  <li key={`${issue.side}-${issue.message}`}>
                    {issue.side ? `${SIDE_LABELS[issue.side]}: ` : ''}
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
            {currentCheck?.status === 'done' && currentCheck.value.ok && (
              <section aria-label="Mapping check" className="mapping-check">
                {RECON_SIDES.map((side) => (
                  <SideCheck key={side} side={side} summary={(currentCheck.value as Extract<NormalizeResult, { ok: true }>).sides[side]} formats={formats} />
                ))}
              </section>
            )}
            {currentReview?.status === 'error' && <p className="error" role="alert">{currentReview.message}</p>}
          </section>
        )}

        {step === 'review' && summary && (
          <section aria-label="Suggested pairs">
            <div className="results-toolbar">
              <div className="metric-grid">
                <Metric label="Candidate pairs" value={count(summary.pairs)} />
                <Metric label="Groups" value={count(summary.groups)} />
                <Metric label="Unique groups" value={count(summary.uniqueGroups)} />
                <Metric label="Without a candidate" value={count(summary.noCandidate.bank + summary.noCandidate.books)} />
              </div>
            </div>
            <p className="key-status">
              {RECON_SIDES.map((side) => (
                <span key={side} className="side-line">
                  {SIDE_LABELS[side]}: {counted(summary.withCandidates[side], 'transaction')} with candidates, {count(summary.noCandidate[side])} without,{' '}
                  {count(summary.invalid[side])} invalid, {count(summary.zero[side])} zero.{' '}
                </span>
              ))}
            </p>
            {summary.incomplete && (
              <p className="warning" role="alert">
                Incomplete search: {summary.incomplete} Transactions without a candidate may have one that was not searched.
              </p>
            )}
            {summary.referenceConflicts > 0 && (
              <p className="note">
                {counted(summary.referenceConflicts, 'pair')} met the amount and date rules but had different references, so{' '}
                {summary.referenceConflicts === 1 ? 'it is' : 'they are'} not suggested.
              </p>
            )}
            <p className="note">
              Rules: exact amount and direction; bank date {summary.rules.bankDaysBefore} day{summary.rules.bankDaysBefore === 1 ? '' : 's'} before to{' '}
              {summary.rules.bankDaysAfter} day{summary.rules.bankDaysAfter === 1 ? '' : 's'} after books;{' '}
              {summary.rules.referencesShared ? `references compared${summary.rules.referenceCaseInsensitive ? ', ignoring case' : ''}` : 'references for context only'}.
              {' '}Account: {context.account || 'unnamed'}, {context.currency} (stated, not checked).
            </p>
            <ReviewView key={summary.matchId} client={client} summary={summary} formats={formats} />
          </section>
        )}

        {step !== 'review' && (
          <div className="step-actions">
            {step === 'files' ? (
              <>
                <span className="note" role="status">{bothReady ? 'Both files ready' : 'Add both files to continue'}</span>
                <button className="primary" type="button" disabled={!bothReady} onClick={() => setStep('map')}>
                  Map dates and amounts <ArrowRight size={16} aria-hidden="true" />
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => setStep('files')}>
                  Back to files
                </button>
                <span className="note" role="status">
                  {!ready ? 'Complete the account and both mappings to continue.' : review && !currentReview ? 'Setup changed. Find suggestions again.' : ''}
                </span>
                <button className="primary" type="button" disabled={!ready || busy} onClick={() => void findSuggestions()}>
                  {currentReview?.status === 'pending' ? 'Finding suggestions…' : 'Find suggestions'}
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </main>
  )
}
