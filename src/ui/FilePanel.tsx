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
        {count(info.recordCount)} data records · {info.headers.length} columns · {DELIMITER_NAMES[info.delimiter]}-delimited
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
  state,
  onPick,
}: {
  title: string
  state: FileState
  onPick: (file: File) => void
}) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      <input
        type="file"
        accept=".csv,.tsv,.txt,text/csv"
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Cleared so picking the same file again (e.g. after a worker crash) still fires change.
          e.target.value = ''
          if (file) onPick(file)
        }}
      />
      {state.status === 'loading' && <p className="muted">Reading {state.file.name}…</p>}
      {state.status === 'ready' && <RecordPreview info={state.info} />}
      {state.status === 'invalid' && <Issues issues={state.issues} />}
      {state.status === 'failed' && <p className="error">{state.message}</p>}
    </section>
  )
}
