import { ArrowRight, Check, FlaskConical } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Layout } from '../../engine/parse'
import { contextIssues } from '../../reconciliation/normalize'
import { DEFAULT_MATCHING, type MatchingRules, RECON_SIDES, type ReconSide, type SessionContext, type SideMapping } from '../../reconciliation/types'
import { CancelledError, createReconcileClient } from '../../worker/client'
import type { Pair } from '../../reconciliation/decisions'
import { type AccountingSetup, emptyAccounting, importSession, type OpeningFile, type SessionFile, type SourceDescriptor } from '../../reconciliation/session'
import { setupFingerprint } from '../../reconciliation/statuses'
import type { DecisionInput, DecisionSummary, MatchSummary, NormalizeResult, OpeningFileInfo, ReconPhase, SourceInfo } from '../../worker/reconcile-protocol'
import { ActivityBar } from '../ActivityBar'
import { download, errorMessage, jsonBlob } from '../browser'
import { WORKSPACE_IDS } from '../mode'
import { fileLabel, type FileState, sheetOf } from '../file-state'
import { count, counted } from '../format'
import { useActivity } from '../use-activity'
import { AccountingFields } from './AccountingFields'
import { ContextFields } from './ContextFields'
import { OpeningPanel } from './OpeningPanel'
import { StatusPanel } from './StatusPanel'
import { draftFromMapping, emptyDraft, type MappingDraft, toMapping } from './mapping-draft'
import { MappingCheck } from './MappingCheck'
import { MappingForm } from './MappingForm'
import { MatchingFields } from './MatchingFields'
import { type Formats, SOURCE_TITLES } from './location'
import { ReviewView } from './ReviewView'
import { SessionBar } from './SessionBar'
import { SourceCheck } from './SourceCheck'
import { SourceFiles } from './SourceFiles'
import { SuggestionSummary } from './SuggestionSummary'
import { indexedDbSessionStore } from './session-store'
import { type SessionConfig, useSession } from './use-session'

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

type Outcome<T> = { inputs: string } & ({ status: 'pending' } | { status: 'done'; value: T } | { status: 'error'; message: string })

type SourceState = FileState<SourceInfo>

interface Reviewed {
  summary: MatchSummary
  decisions: DecisionSummary
}

// The worker's state is gone, so a file with problems must be read again too: its full
// problem list lived in the worker.
function failIfLoaded(state: SourceState, reason: string): SourceState {
  if (state.status === 'empty' || state.status === 'failed') return state
  return { status: 'failed', file: state.file, message: reason, sheet: sheetOf(state) }
}

export function ReconcileApp() {
  const [requestedStep, setStep] = useState<Step>('files')
  const [files, setFiles] = useState<Record<ReconSide, SourceState>>({ bank: { status: 'empty' }, books: { status: 'empty' } })
  // The files as of the latest render, for work that finishes after an await (resuming a
  // saved session) and must re-read whatever is loaded by then.
  const filesRef = useRef(files)
  useEffect(() => {
    filesRef.current = files
  }, [files])
  const [drafts, setDrafts] = useState<Record<ReconSide, MappingDraft>>({ bank: emptyDraft(), books: emptyDraft() })
  const [context, setContext] = useState<SessionContext>({ account: '', currency: '', minorUnits: 2 })
  const [accounting, setAccounting] = useState<AccountingSetup>(emptyAccounting)
  const [openingFiles, setOpeningFiles] = useState<OpeningFile[]>([])
  const [openingInfo, setOpeningInfo] = useState<OpeningFileInfo[]>([])
  const [openingErrors, setOpeningErrors] = useState<string[]>([])
  const [rules, setRules] = useState<MatchingRules>(DEFAULT_MATCHING)
  const [dataVersion, setDataVersion] = useState(0)
  const [check, setCheck] = useState<Outcome<NormalizeResult> | null>(null)
  const [review, setReview] = useState<Outcome<Reviewed> | null>(null)
  const [decisionVersion, setDecisionVersion] = useState(0)
  const [deciding, setDeciding] = useState(false)
  const [decideError, setDecideError] = useState<string | null>(null)
  const [sessionMessage, setSessionMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)
  const [store] = useState(indexedDbSessionStore)
  const { activity, track, clear: clearActivity } = useActivity<Task, ReconPhase>()
  const loadTokens = useRef<Record<ReconSide, number>>({ bank: 0, books: 0 })
  const [client] = useState(() =>
    createReconcileClient((reason) => {
      setFiles((prev) => ({ bank: failIfLoaded(prev.bank, reason), books: failIfLoaded(prev.books, reason) }))
      setDataVersion((v) => v + 1)
    }),
  )
  useEffect(() => () => client.terminate(), [client])

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
        if (isCurrent()) setFiles((prev) => ({ ...prev, [side]: { status: 'failed', file, message: errorMessage(error), sheet } }))
      })
      .finally(task.end)
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
  const sources: Record<ReconSide, SourceDescriptor> | null =
    files.bank.status === 'ready' && files.books.status === 'ready'
      ? {
          bank: { fileName: files.bank.file.name, fingerprint: files.bank.info.fingerprint, sheet: sheetOf(files.bank) ?? null, recordCount: files.bank.info.recordCount },
          books: { fileName: files.books.file.name, fingerprint: files.books.info.fingerprint, sheet: sheetOf(files.books) ?? null, recordCount: files.books.info.recordCount },
        }
      : null
  // References can only be compared when both sides map a reference column.
  const bothReferences = drafts.bank.reference !== '' && drafts.books.reference !== ''
  const effectiveRules: MatchingRules = bothReferences ? rules : { ...rules, referencesShared: false, referenceCaseInsensitive: false }
  const config: SessionConfig | null = ready && mappings && sources ? { context, mappings, rules: effectiveRules, sources, accounting, opening: openingFiles } : null
  // What a mark-complete is made for: any change to it withdraws the completion.
  const basis = config ? setupFingerprint(config) : ''
  const session = useSession(store, config)
  // With opening items imported, the period decides whether they are accepted; without
  // any, it doesn't affect matching, so editing it keeps the review.
  const openingKey = openingFiles.length > 0 ? { period: accounting.period, opening: openingFiles.map((f) => f.name + f.text.length) } : null
  const checkInputs = JSON.stringify({ dataVersion, context, mappings, openingKey })
  const reviewInputs = JSON.stringify({ checkInputs, rules: effectiveRules })
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
      // Sent with every check, even when empty: the worker may have lost its copy (Cancel, a
      // crash), or may still hold files from a session loaded earlier.
      const sent = await client.call('setOpening', { files: openingFiles })
      if (!sent.ok) throw new Error(sent.errors.map((e) => `${e.name}: ${e.message}`).join('; '))
      const value = await client.call('normalize', { context, mappings, period: accounting.period }, task.progress)
      setCheck({ inputs, status: 'done', value })
      return value
    } catch (error) {
      setCheck({ inputs, status: 'error', message: error instanceof CancelledError ? 'Cancelled.' : errorMessage(error) })
      return null
    } finally {
      task.end()
    }
  }

  // Validated by the worker before it is kept; a file that can't be read is refused whole.
  async function replaceOpening(files: OpeningFile[]) {
    setOpeningErrors([])
    try {
      const result = await client.call('setOpening', { files })
      if (!result.ok) {
        setOpeningErrors(result.errors.map((e) => `${e.name}: ${e.message}`))
        return
      }
      setOpeningFiles(files)
      setOpeningInfo(result.files)
      setDataVersion((v) => v + 1)
    } catch (error) {
      setOpeningErrors([errorMessage(error)])
    }
  }

  async function addOpening(picked: File[]) {
    const added = await Promise.all(picked.map(async (file) => ({ name: file.name, text: await file.text() })))
    const names = new Set(added.map((f) => f.name))
    await replaceOpening([...openingFiles.filter((f) => !names.has(f.name)), ...added])
  }

  async function findSuggestions() {
    const inputs = reviewInputs
    const normalized = await normalize(checkInputs)
    if (!normalized?.ok) return
    const task = track('match')
    task.show()
    setReview({ inputs, status: 'pending' })
    try {
      const summary = await client.call('match', { revision: normalized.revision, rules: effectiveRules }, task.progress)
      // The worker keeps no history of its own: send it after every run.
      const decisions = await client.call('setDecisions', { matchId: summary.matchId, events: session.eventsRef.current })
      if (session.expected && sources && RECON_SIDES.every((side) =>
        sources[side].fingerprint === session.expected?.[side].fingerprint &&
        sources[side].sheet === session.expected?.[side].sheet,
      )) {
        setSessionMessage((current) => current?.kind === 'info' ? null : current)
      }
      setReview({ inputs, status: 'done', value: { summary, decisions } })
      setDecisionVersion((v) => v + 1)
      setDecideError(null)
      setStep('review')
    } catch (error) {
      setReview({ inputs, status: 'error', message: error instanceof CancelledError ? 'Cancelled.' : errorMessage(error) })
    } finally {
      task.end()
    }
  }

  async function decide(decision: DecisionInput): Promise<string | null> {
    if (currentReview?.status !== 'done') return 'Find suggestions first'
    const { summary } = currentReview.value
    setDeciding(true)
    setDecideError(null)
    try {
      const result = await client.call('decide', { matchId: summary.matchId, seq: session.eventsRef.current.length + 1, at: new Date().toISOString(), decision })
      if (!result.ok) {
        setDecideError(result.reason)
        return result.reason
      }
      session.record([result.event], result.snapshots)
      setReview({ ...currentReview, value: { summary, decisions: result.summary } })
      setDecisionVersion((v) => v + 1)
      return null
    } catch (error) {
      const text = errorMessage(error)
      setDecideError(text)
      return text
    } finally {
      setDeciding(false)
    }
  }

  async function decideSet(group: number, pairs: Pair[]): Promise<string | null> {
    if (currentReview?.status !== 'done') return 'Find suggestions first'
    const { summary } = currentReview.value
    setDeciding(true)
    setDecideError(null)
    try {
      const result = await client.call('decideSet', { matchId: summary.matchId, group, seq: session.eventsRef.current.length + 1, at: new Date().toISOString(), pairs })
      if (!result.ok) return result.reason
      session.record(result.events, result.snapshots)
      setReview({ ...currentReview, value: { summary, decisions: result.summary } })
      setDecisionVersion((v) => v + 1)
      return null
    } catch (error) {
      return errorMessage(error)
    } finally {
      setDeciding(false)
    }
  }

  function adopt(file: SessionFile, fromBrowser: boolean) {
    session.load(file, fromBrowser)
    setContext(file.context)
    setRules(file.rules)
    setAccounting(file.accounting)
    setOpeningFiles(file.opening)
    setOpeningInfo([])
    setOpeningErrors([])
    setDrafts({ bank: draftFromMapping(file.mappings.bank), books: draftFromMapping(file.mappings.books) })
    setReview(null)
    setCheck(null)
    setStep('files')
    setSessionMessage({
      kind: 'info',
      text: `Loaded a session at revision ${count(file.revision)} with ${counted(file.events.length, 'decision')}. Load the same files, then find suggestions to apply them.`,
    })
    for (const side of RECON_SIDES) {
      const state = filesRef.current[side]
      const draft = draftFromMapping(file.mappings[side])
      if (state.status !== 'empty') load(side, state.file, draft, file.sources[side].sheet ?? undefined)
    }
  }

  async function importFile(file: File) {
    try {
      adopt(importSession(await file.text()), false)
    } catch (error) {
      setSessionMessage({ kind: 'error', text: `This session file can't be used: ${errorMessage(error)}` })
    }
  }

  async function resume() {
    try {
      const saved = await session.readSaved()
      if (saved) adopt(saved, true)
    } catch (error) {
      setSessionMessage({ kind: 'error', text: `The session saved in this browser can't be read: ${errorMessage(error)}. Delete it to save again.` })
    }
  }

  function cancel() {
    client.cancel()
    clearActivity()
    setFiles((prev) => ({ bank: failIfLoaded(prev.bank, 'Cancelled.'), books: failIfLoaded(prev.books, 'Cancelled.') }))
    setDataVersion((v) => v + 1)
  }

  const reviewed = currentReview?.status === 'done' ? currentReview.value : null
  const summary = reviewed?.summary ?? null
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
          <FlaskConical size={16} aria-hidden="true" /> Experimental. You confirm every match; nothing is confirmed automatically. A reconciliation
          counts as completed only when every status is earned and you mark it complete.
        </p>
        <SessionBar
          revision={session.revision}
          decisions={session.events.length}
          storage={session.storage}
          backup={session.backup}
          autosave={session.autosave}
          storageAvailable={session.available}
          stored={session.stored}
          ownId={session.id}
          conflict={session.conflict}
          canExport={config !== null}
          message={sessionMessage}
          onExport={() => {
            if (!config) return
            const { text, revision } = session.exportBackup(config)
            download(jsonBlob(text), `reconciliation-session-r${revision}.json`)
          }}
          onImport={(file) => void importFile(file)}
          onAutosave={session.setAutosave}
          onResume={() => void resume()}
          onDelete={() => void session.deleteSaved()}
        />
        {session.expected && <SourceCheck expected={session.expected} files={files} />}
        <div className="workspace-heading">
          <div>
            <h1 ref={stepHeading} tabIndex={-1}>
              {step === 'files' ? 'Reconcile a bank statement' : step === 'map' ? 'Map dates and amounts' : 'Review pairs'}
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
          <SourceFiles
            files={files}
            drafts={drafts}
            onPick={load}
            onChangeReading={changeReading}
            fetchIssues={(side, offset, limit) => client.call('getIssues', { side, offset, limit })}
          />
        )}

        {step === 'map' && headers.bank && headers.books && (
          <section aria-label="Mapping" className="rules-panel">
            <ContextFields context={context} issues={sessionIssues} onChange={setContext} />
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
            <AccountingFields setup={accounting} onChange={setAccounting} />
            <OpeningPanel
              files={openingFiles}
              info={openingInfo}
              errors={openingErrors}
              onAdd={(picked) => void addOpening(picked)}
              onRemove={(name) => void replaceOpening(openingFiles.filter((f) => f.name !== name))}
            />
            <MatchingFields rules={rules} effective={effectiveRules} referencesMapped={bothReferences} onChange={setRules} />

            <div className="row">
              <button type="button" disabled={!ready || busy} onClick={() => void normalize(checkInputs)}>
                Check mapping
              </button>
              {check && !currentCheck && <span className="note">The mapping changed; check it again.</span>}
            </div>
            {currentCheck?.status === 'error' && <p className="error" role="alert">{currentCheck.message}</p>}
            {currentCheck?.status === 'done' && <MappingCheck result={currentCheck.value} formats={formats} />}
            {currentReview?.status === 'error' && <p className="error" role="alert">{currentReview.message}</p>}
          </section>
        )}

        {step === 'review' && summary && (
          <section aria-label="Suggested pairs">
            <SuggestionSummary summary={summary} context={context} />
            <StatusPanel
              client={client}
              matchId={summary.matchId}
              setup={accounting}
              basis={basis}
              version={decisionVersion}
              busy={deciding}
              nextSeq={() => session.eventsRef.current.length + 1}
              onCompleted={(event) => {
                session.record([event], [])
                setDecisionVersion((v) => v + 1)
              }}
              sessionId={session.id}
              revision={session.revision}
            />
            <ReviewView
              key={summary.matchId}
              client={client}
              summary={summary}
              decisions={(reviewed as Reviewed).decisions}
              version={decisionVersion}
              events={session.events}
              snapshots={session.snapshots}
              busy={deciding}
              error={decideError}
              formats={formats}
              onDecide={decide}
              onDecideSet={decideSet}
            />
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
