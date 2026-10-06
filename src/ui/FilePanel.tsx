import { useId, useState } from 'react'
import { CheckCircle2, FileSpreadsheet, UploadCloud } from 'lucide-react'
import type { ParseIssue } from '../engine/parse'
import type { FileInfo, Preview } from '../worker/protocol'
import { count, RECORD_NUMBER_NOTE } from './format'
import { ShowingNote } from './ShowingNote'

export type FileState =
  | { status: 'empty' }
  | { status: 'loading'; file: File }
  | { status: 'ready'; file: File; info: FileInfo }
  | { status: 'invalid'; file: File; issues: Preview<ParseIssue> }
  | { status: 'failed'; file: File; message: string }

const DELIMITER_NAMES: Record<FileInfo['delimiter'], string> = { ',': 'comma', ';': 'semicolon', '\t': 'tab' }

function Issues({ issues }: { issues: Preview<ParseIssue> }) {
  const hasRecords = issues.items.some((issue) => issue.kind === 'record')
  return (
    <div className="error">
      <p>
        {count(issues.total)} problem{issues.total === 1 ? '' : 's'} found. Fix the export and load it again; nothing is
        compared until the file is clean.
      </p>
      <ul>
        {issues.items.map((issue, i) =>
          issue.kind === 'record' ? (
            <li key={i}>
              Data record {issue.recordNumber}: {issue.message}
              <pre>{issue.raw}</pre>
            </li>
          ) : (
            <li key={i}>
              {issue.kind === 'header' ? 'Header: ' : ''}
              {issue.message}
            </li>
          ),
        )}
      </ul>
      <ShowingNote shown={issues.items.length} total={issues.total} />
      {hasRecords && <p className="note">{RECORD_NUMBER_NOTE}</p>}
    </div>
  )
}

function RecordPreview({ info }: { info: FileInfo }) {
  return (
    <>
      <p>
        {count(info.recordCount)} data records · {info.headers.length} columns · {DELIMITER_NAMES[info.delimiter]}
        -delimited
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

export function FilePanel({ title, state, onPick }: { title: string; state: FileState; onPick: (file: File) => void }) {
  const inputId = useId()
  const [dragging, setDragging] = useState(false)
  return (
    <section
      className={`panel file-panel ${dragging ? 'dragging' : ''} ${state.status === 'ready' ? 'file-ready' : ''}`}
    >
      <div className="file-heading">
        <h2>
          <span className="file-side">{title === 'Old file' ? 'A' : 'B'}</span>
          {title}
          <span className="muted">{title === 'Old file' ? 'Baseline' : 'Updated'}</span>
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
        <strong>{state.status === 'empty' ? 'Drop your CSV here' : state.file.name}</strong>
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
            ? 'CSV, TSV or delimited text'
            : `${(state.file.size / 1024).toLocaleString('en-US', { maximumFractionDigits: 1 })} KB`}
        </small>
        <input
          id={inputId}
          className="file-input"
          aria-label={`Choose ${title.toLowerCase()}`}
          type="file"
          accept=".csv,.tsv,.txt,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) onPick(file)
          }}
        />
      </label>
      {state.status === 'loading' && (
        <p className="muted" role="status">
          Reading {state.file.name}…
        </p>
      )}
      {state.status === 'ready' && (
        <>
          <p className="file-stats">
            <strong>{count(state.info.recordCount)}</strong> records <span>·</span>{' '}
            <strong>{state.info.headers.length}</strong> columns <span>·</span> {DELIMITER_NAMES[state.info.delimiter]}
          </p>
          <details className="preview-disclosure">
            <summary>Preview first {Math.min(20, state.info.recordCount)} records</summary>
            <RecordPreview info={state.info} />
          </details>
        </>
      )}
      {state.status === 'invalid' && <Issues issues={state.issues} />}
      {state.status === 'failed' && (
        <p className="error" role="alert">
          {state.message}{' '}
          <button type="button" className="secondary" onClick={() => onPick(state.file)}>
            Read {state.file.name} again
          </button>
        </p>
      )}
    </section>
  )
}
