import { type ReactNode, useId, useState } from 'react'
import { CheckCircle2, FileSpreadsheet, UploadCloud } from 'lucide-react'
import type { ParseIssue } from '../engine/parse'
import type { Delimiter, FileFormat } from '../engine/types'
import type { FileState } from './file-state'
import type { FileInfo, Preview } from '../worker/protocol'
import { count, counted, noun, RECORD_NUMBER_NOTE } from './format'
import { Select } from './Select'
import type { Page } from './results/page-loader'
import { VirtualList } from './results/VirtualList'
import { ShowingNote } from './ShowingNote'

function SheetPicker({ title, format, onPickSheet }: { title: string; format?: FileFormat; onPickSheet: (sheet: string) => void }) {
  if (format?.kind !== 'xlsx' || format.sheets.length < 2) return null
  return (
    <div className="parse-toolbar">
      <span>Sheet</span>
      <Select<string>
        label={`Sheet in ${title.toLowerCase()}`}
        value={format.sheet}
        onChange={onPickSheet}
        options={format.sheets.map((sheet) => ({ value: sheet, label: sheet }))}
      />
    </div>
  )
}

type IssuePager = (offset: number, limit: number) => Promise<Page<ParseIssue>>

const DELIMITER_NAMES: Record<Delimiter, string> = { ',': 'comma', ';': 'semicolon', '\t': 'tab' }

function formatName(format: FileFormat): string {
  return format.kind === 'csv' ? `${DELIMITER_NAMES[format.delimiter]}-delimited` : `sheet “${format.sheet}”`
}

function IssueItem({ issue }: { issue: ParseIssue }) {
  return issue.kind === 'record' ? (
    <>
      Data record {issue.recordNumber}: {issue.message}
      <pre>{issue.raw}</pre>
    </>
  ) : (
    <>
      {issue.kind === 'header' ? 'Header: ' : ''}
      {issue.message}
    </>
  )
}

function Issues({ issues, fetchIssues }: { issues: Preview<ParseIssue>; fetchIssues: IssuePager }) {
  const [showAll, setShowAll] = useState(false)
  const hasRecords = issues.items.some((issue) => issue.kind === 'record')
  const more = issues.total > issues.items.length
  return (
    <div className="error">
      <p>
        {counted(issues.total, 'problem')} found. Fix the export and load it again; nothing is
        compared until the file is clean.
      </p>
      {showAll ? (
        <VirtualList<ParseIssue>
          fetchPage={fetchIssues}
          estimateSize={56}
          empty="No problems."
          label="File problems, scroll to browse"
          renderRow={(issue) => <div className="issue-row">{issue ? <IssueItem issue={issue} /> : '…'}</div>}
        />
      ) : (
        <>
          <ul>
            {issues.items.map((issue, i) => (
              <li key={i}>
                <IssueItem issue={issue} />
              </li>
            ))}
          </ul>
          <ShowingNote shown={issues.items.length} total={issues.total} />
        </>
      )}
      {more && (
        <button type="button" className="secondary" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show the first few' : `View all ${count(issues.total)} problems`}
        </button>
      )}
      {hasRecords && <p className="note">{RECORD_NUMBER_NOTE}</p>}
    </div>
  )
}

function RecordPreview({ info }: { info: FileInfo }) {
  return (
    <>
      <p>
        {counted(info.recordCount, 'data record')} · {counted(info.headers.length, 'column')} · {formatName(info.format)}
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th title={RECORD_NUMBER_NOTE}>Record</th>
              {info.headers.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {info.preview.map((row, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                {info.headers.map((h) => (
                  <td key={h}>{row[h]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="muted">
        <ShowingNote shown={info.preview.length} total={info.recordCount} />
      </div>
    </>
  )
}

export function FilePanel({
  title,
  badge = title === 'Old file' ? 'A' : 'B',
  caption = title === 'Old file' ? 'Baseline' : 'Updated',
  state,
  onPick,
  onPickSheet,
  fetchIssues,
  children,
}: {
  title: string
  badge?: string
  caption?: string
  state: FileState
  // Shown under the drop zone, e.g. settings for how this file is read.
  children?: ReactNode
  onPick: (file: File, sheet?: string) => void
  onPickSheet: (sheet: string) => void
  fetchIssues: IssuePager
}) {
  const inputId = useId()
  const [dragging, setDragging] = useState(false)
  return (
    <section
      className={`panel file-panel ${dragging ? 'dragging' : ''} ${state.status === 'ready' ? 'file-ready' : ''}`}
    >
      <div className="file-heading">
        <h2>
          <span className="file-side">{badge}</span>
          {title}
          <span className="muted">{caption}</span>
        </h2>
        {state.status === 'ready' && (
          <span className="ready-badge">
            <CheckCircle2 size={13} /> Ready
          </span>
        )}
      </div>
      <label
        className="drop-zone"
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const file = e.dataTransfer.files[0]
          if (file) onPick(file)
        }}
      >
        <span className="upload-icon">
          {state.status === 'empty' ? <UploadCloud size={24} /> : <FileSpreadsheet size={24} />}
        </span>
        <strong>{state.status === 'empty' ? 'Drop your CSV or .xlsx here' : state.file.name}</strong>
        <span>
          {state.status === 'empty' ? (
            <>
              or <span className="browse-link">browse files</span>
            </>
          ) : (
            <span className="browse-link">Choose a different file</span>
          )}
        </span>
        <small>
          {state.status === 'empty'
            ? 'CSV, TSV, delimited text or an .xlsx workbook'
            : `${(state.file.size / 1024).toLocaleString('en-US', { maximumFractionDigits: 1 })} KB`}
        </small>
        <input
          id={inputId}
          className="file-input"
          aria-label={`Choose ${title.toLowerCase()}`}
          type="file"
          accept=".csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) onPick(file)
          }}
        />
      </label>
      {children}
      {state.status === 'loading' && (
        <p className="muted" role="status">
          Reading {state.file.name}…
        </p>
      )}
      {state.status === 'ready' && (
        <>
          <p className="file-stats">
            <strong>{count(state.info.recordCount)}</strong> {noun(state.info.recordCount, 'record')} <span>·</span>{' '}
            <strong>{state.info.headers.length}</strong> {noun(state.info.headers.length, 'column')} <span>·</span>{' '}
            {formatName(state.info.format)}
          </p>
          <SheetPicker title={title} format={state.info.format} onPickSheet={onPickSheet} />
          {state.info.format.kind === 'xlsx' && (
            <p className="note">Cells are compared as Excel displays them; a formula gives the value Excel last saved.</p>
          )}
          {state.info.notes.map((note) => (
            <p key={note} className="note">
              {note}
            </p>
          ))}
          <details className="preview-disclosure">
            <summary>Preview first {counted(Math.min(20, state.info.recordCount), 'record')}</summary>
            <RecordPreview info={state.info} />
          </details>
        </>
      )}
      {state.status === 'invalid' && (
        <>
          <SheetPicker title={title} format={state.format} onPickSheet={onPickSheet} />
          <Issues issues={state.issues} fetchIssues={fetchIssues} />
        </>
      )}
      {state.status === 'failed' && (
        <p className="error" role="alert">
          {state.message}{' '}
          <button type="button" className="secondary" onClick={() => onPick(state.file, state.sheet)}>
            Read {state.file.name}
            {state.sheet ? ` (sheet “${state.sheet}”)` : ''} again
          </button>
        </p>
      )}
    </section>
  )
}
