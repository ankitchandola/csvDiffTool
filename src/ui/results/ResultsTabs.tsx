import { type CSSProperties, useState } from 'react'
import type { CompareClient } from '../../worker/client'
import type { CompareWarning, EmptyKeyRecord } from '../../engine/types'
import type {
  AmbiguousKeyPreview,
  ChangedEntry,
  CompareResult,
  PageItems,
  RecordEntry,
  ResultTab,
} from '../../worker/protocol'
import { count, formatKey, RECORD_NUMBER_NOTE } from '../format'
import type { Page } from './page-loader'
import { VirtualList } from './VirtualList'

type Tab = 'added' | 'removed' | 'changed' | 'problems'
type Problem = 'ambiguous' | 'emptyKey' | 'warnings'

const PROBLEM_LABELS: Record<Problem, string> = {
  ambiguous: 'Ambiguous keys',
  emptyKey: 'Empty keys',
  warnings: 'Numeric warnings',
}

function pager<K extends ResultTab>(client: CompareClient, tab: K, column?: string) {
  return async (offset: number, limit: number): Promise<Page<PageItems[K]>> => {
    const page = await client.call('getRows', { tab, offset, limit, column })
    return { total: page.total, items: page.items as PageItems[K][] }
  }
}

function Pending() {
  return <div className="cell muted">…</div>
}

function grid(columns: string): CSSProperties {
  return { display: 'grid', gridTemplateColumns: columns }
}

function RecordTable({ client, tab, headers }: { client: CompareClient; tab: 'added' | 'removed'; headers: string[] }) {
  const template = `7rem 12rem repeat(${headers.length}, 12rem)`
  return (
    <VirtualList<RecordEntry>
      fetchPage={pager(client, tab)}
      estimateSize={34}
      minWidth={`${19 + 12 * headers.length}rem`}
      empty={tab === 'added' ? 'No records were added.' : 'No records were removed.'}
      header={
        <div style={grid(template)}>
          <div className="cell" title={RECORD_NUMBER_NOTE}>
            {tab === 'added' ? 'New record' : 'Old record'}
          </div>
          <div className="cell">Key</div>
          {headers.map((h) => (
            <div key={h} className="cell">
              {h}
            </div>
          ))}
        </div>
      }
      renderRow={(entry) =>
        entry ? (
          <div style={grid(template)}>
            <div className="cell">{entry.recordNumber}</div>
            <div className="cell">{formatKey(entry.key.parts)}</div>
            {headers.map((h) => (
              <div key={h} className="cell">
                {entry.row[h]}
              </div>
            ))}
          </div>
        ) : (
          <Pending />
        )
      }
    />
  )
}

function ChangedTable({ client, column }: { client: CompareClient; column: string | undefined }) {
  const template = '9rem 12rem minmax(24rem, 1fr)'
  return (
    <VirtualList<ChangedEntry>
      fetchPage={pager(client, 'changed', column)}
      estimateSize={34}
      minWidth="45rem"
      empty={column ? `No record changed in ${column}.` : 'No records changed.'}
      header={
        <div style={grid(template)}>
          <div className="cell" title={RECORD_NUMBER_NOTE}>
            Record (old → new)
          </div>
          <div className="cell">Key</div>
          <div className="cell">Changes</div>
        </div>
      }
      renderRow={(entry) =>
        entry ? (
          <div style={grid(template)}>
            <div className="cell">
              {entry.oldRecordNumber} → {entry.newRecordNumber}
            </div>
            <div className="cell">{formatKey(entry.key.parts)}</div>
            <div className="cell changes">
              {entry.changes.map((change) => (
                <div key={change.column} className={change.column === column ? 'change focus' : 'change'}>
                  <span className="change-column">{change.column}</span>
                  <span className="before">{change.before}</span>
                  <span aria-hidden="true">→</span>
                  <span className="after">{change.after}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <Pending />
        )
      }
    />
  )
}

function ProblemTable({ client, problem }: { client: CompareClient; problem: Problem }) {
  const empty = `No ${PROBLEM_LABELS[problem].toLowerCase()}.`
  if (problem === 'ambiguous') {
    return (
      <VirtualList<AmbiguousKeyPreview>
        fetchPage={pager(client, 'ambiguous')}
        estimateSize={34}
        empty={empty}
        renderRow={(group) =>
          group ? (
            <div className="cell">
              <strong>{formatKey(group.old[0]?.parts ?? group.new[0]?.parts ?? [])}</strong>{' '}
              <span className="muted">
                — {count(group.oldCount)} in old, {count(group.newCount)} in new:{' '}
                {group.old
                  .map((r) => `old ${r.recordNumber} (${formatKey(r.parts)})`)
                  .concat(group.new.map((r) => `new ${r.recordNumber} (${formatKey(r.parts)})`))
                  .join(', ')}
                {group.oldCount + group.newCount > group.old.length + group.new.length &&
                  `, and ${count(group.oldCount + group.newCount - group.old.length - group.new.length)} more`}
              </span>
            </div>
          ) : (
            <Pending />
          )
        }
      />
    )
  }
  if (problem === 'emptyKey') {
    return (
      <VirtualList<EmptyKeyRecord>
        fetchPage={pager(client, 'emptyKey')}
        estimateSize={34}
        empty={empty}
        renderRow={(r) =>
          r ? (
            <div className="cell">
              {r.side} data record {r.recordNumber}: {r.parts.map((p) => JSON.stringify(p)).join(', ')}
            </div>
          ) : (
            <Pending />
          )
        }
      />
    )
  }
  return (
    <VirtualList<CompareWarning>
      fetchPage={pager(client, 'warnings')}
      estimateSize={34}
      empty={empty}
      renderRow={(w) =>
        w ? (
          <div className="cell">
            {w.side} data record {w.recordNumber}, {w.column}: {w.message}
          </div>
        ) : (
          <Pending />
        )
      }
    />
  )
}

export function ResultsTabs({
  client,
  result,
  resultKey,
  oldHeaders,
  newHeaders,
}: {
  client: CompareClient
  result: CompareResult
  resultKey: string
  oldHeaders: string[]
  newHeaders: string[]
}) {
  const { counts, changesByColumn } = result.summary
  const problemCounts: Record<Problem, number> = {
    ambiguous: result.ambiguous.total,
    emptyKey: result.emptyKey.total,
    warnings: result.warnings.total,
  }
  const problemTotal = problemCounts.ambiguous + problemCounts.emptyKey + problemCounts.warnings
  const [tab, setTab] = useState<Tab>('changed')
  const [column, setColumn] = useState('')
  const [problem, setProblem] = useState<Problem>('ambiguous')
  const filterColumn = column !== '' && Object.hasOwn(changesByColumn, column) ? column : undefined

  const tabs: [Tab, string, number][] = [
    ['added', 'Added', counts.added],
    ['removed', 'Removed', counts.removed],
    ['changed', 'Changed', counts.changed],
    ['problems', 'Problems', problemTotal],
  ]

  return (
    <section className="panel">
      <div className="tabs" role="tablist">
        {tabs.map(([id, label, n]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'tab active' : 'tab'}
            onClick={() => setTab(id)}
          >
            {label} ({count(n)})
          </button>
        ))}
      </div>

      {tab === 'added' && <RecordTable key={`${resultKey}-added`} client={client} tab="added" headers={newHeaders} />}
      {tab === 'removed' && <RecordTable key={`${resultKey}-removed`} client={client} tab="removed" headers={oldHeaders} />}
      {tab === 'changed' && (
        <>
          <label className="row">
            Show records where{' '}
            <select value={filterColumn ?? ''} onChange={(e) => setColumn(e.target.value)}>
              <option value="">any column changed ({count(counts.changed)})</option>
              {Object.entries(changesByColumn)
                .sort(([, a], [, b]) => b - a)
                .map(([c, n]) => (
                  <option key={c} value={c}>
                    {c} changed ({count(n)})
                  </option>
                ))}
            </select>
          </label>
          <ChangedTable key={`${resultKey}-changed-${filterColumn ?? ''}`} client={client} column={filterColumn} />
        </>
      )}
      {tab === 'problems' && (
        <>
          <div className="row">
            {(Object.keys(PROBLEM_LABELS) as Problem[]).map((p) => (
              <button
                key={p}
                type="button"
                className={problem === p ? 'tab active' : 'tab'}
                onClick={() => setProblem(p)}
              >
                {PROBLEM_LABELS[p]} ({count(problemCounts[p])})
              </button>
            ))}
          </div>
          <ProblemTable key={`${resultKey}-${problem}`} client={client} problem={problem} />
        </>
      )}
      <p className="note">{RECORD_NUMBER_NOTE}</p>
    </section>
  )
}
