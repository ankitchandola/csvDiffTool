import type { ParseIssue } from '../engine/parse'
import type { FileInfo } from '../worker/protocol'

export type FileState =
  | { status: 'empty' }
  | { status: 'loading'; file: File }
  | { status: 'ready'; file: File; info: FileInfo }
  | { status: 'invalid'; file: File; issues: ParseIssue[]; issueCount: number }
  | { status: 'failed'; file: File; message: string }

const DELIMITER_NAMES: Record<FileInfo['delimiter'], string> = { ',': 'comma', ';': 'semicolon', '\t': 'tab' }

function Issues({ issues, issueCount }: { issues: ParseIssue[]; issueCount: number }) {
  return (
    <div className="error">
      <p>
        {issueCount} problem{issueCount === 1 ? '' : 's'} found. Fix the export and load it again; nothing is compared
        until the file is clean.
      </p>
      <ul>
        {issues.map((issue, i) =>
          issue.kind === 'header' ? (
            <li key={i}>Header: {issue.message}</li>
          ) : (
            <li key={i}>
              Record {issue.recordNumber}: {issue.message}
              <pre>{issue.raw}</pre>
            </li>
          ),
        )}
      </ul>
      {issueCount > issues.length && <p>Showing the first {issues.length}.</p>}
    </div>
  )
}

function Preview({ info }: { info: FileInfo }) {
  return (
    <>
      <p>
        {info.recordCount} records · {info.headers.length} columns · {DELIMITER_NAMES[info.delimiter]}-delimited
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
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
      {info.recordCount > info.preview.length && <p className="muted">First {info.preview.length} records shown.</p>}
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
          if (file) onPick(file)
        }}
      />
      {state.status === 'loading' && <p className="muted">Reading {state.file.name}…</p>}
      {state.status === 'ready' && <Preview info={state.info} />}
      {state.status === 'invalid' && <Issues issues={state.issues} issueCount={state.issueCount} />}
      {state.status === 'failed' && <p className="error">{state.message}</p>}
    </section>
  )
}
