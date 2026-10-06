import { ArrowRightLeft, Filter, Minus, Plus, TriangleAlert } from 'lucide-react'
import { type CSSProperties, useState } from 'react'
import type { CompareClient } from '../../worker/client'
import type { CompareWarning, EmptyKeyRecord } from '../../engine/types'
import type {
  AmbiguousRecord,
  ChangedEntry,
  CompareResult,
  PageItems,
  RecordEntry,
  ResultTab,
} from '../../worker/protocol'
import { count, counted, formatKey, formatValue, noun, RECORD_NUMBER_NOTE } from '../format'
import type { Page } from './page-loader'
import { firstRelevantTab, type Tab } from './tabs'
import { VirtualList } from './VirtualList'
import { Select } from '../Select'

const TAB_ICONS = { added: Plus, removed: Minus, changed: ArrowRightLeft, problems: TriangleAlert }

type Problem = 'ambiguous' | 'emptyKey' | 'warnings'

const PROBLEM_LABELS: Record<Problem, string> = {
  ambiguous: 'Ambiguous keys',
  emptyKey: 'Empty keys',
  warnings: 'Numeric warnings',
}

function pager<K extends ResultTab>(client: CompareClient, resultId: number, tab: K, column?: string) {
  return async (offset: number, limit: number): Promise<Page<PageItems[K]>> => {
    const page = await client.call('getRows', { resultId, tab, offset, limit, column })
    return { total: page.total, items: page.items as PageItems[K][] }
  }
}

function Pending() {
  return <div className="cell muted">…</div>
}

function grid(columns: string): CSSProperties {
  return { display: 'grid', gridTemplateColumns: columns }
}

function RecordTable({
  client,
  resultId,
  tab,
  headers,
}: {
  client: CompareClient
  resultId: number
  tab: 'added' | 'removed'
  headers: string[]
}) {
  const template = `7rem 12rem repeat(${headers.length}, 12rem)`
  return (
    <VirtualList<RecordEntry>
      fetchPage={pager(client, resultId, tab)}
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
                {formatValue(entry.row[h])}
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

function ChangedTable({
  client,
  resultId,
  column,
}: {
  client: CompareClient
  resultId: number
  column: string | undefined
}) {
  const template = '9rem 12rem minmax(24rem, 1fr)'
  return (
    <VirtualList<ChangedEntry>
      fetchPage={pager(client, resultId, 'changed', column)}
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
            <div className="cell">
              {formatKey(entry.key.parts)}
              {formatKey(entry.oldKeyParts) !== formatKey(entry.key.parts) && (
                <div className="muted">old: {formatKey(entry.oldKeyParts)}</div>
              )}
            </div>
            <div className="cell changes">
              {entry.changes.map((change) => (
                <div key={change.column} className={change.column === column ? 'change focus' : 'change'}>
                  <span className="change-column">{change.column}</span>
                  <span className="before">
                    <span className="visually-hidden">before: </span>
                    {formatValue(change.before)}
                  </span>
                  <span aria-hidden="true">→</span>
                  <span className="after">
                    <span className="visually-hidden">after: </span>
                    {formatValue(change.after)}
                  </span>
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

function ProblemTable({ client, resultId, problem }: { client: CompareClient; resultId: number; problem: Problem }) {
  const empty = `No ${PROBLEM_LABELS[problem].toLowerCase()}.`
  if (problem === 'ambiguous') {
    return (
      <VirtualList<AmbiguousRecord>
        fetchPage={pager(client, resultId, 'ambiguous')}
        estimateSize={34}
        empty={empty}
        header={
          <div style={grid('14rem 7rem 9rem 1fr')}>
            <div className="cell">Key</div>
            <div className="cell">File</div>
            <div className="cell" title={RECORD_NUMBER_NOTE}>
              Data record
            </div>
            <div className="cell">Records sharing this key</div>
          </div>
        }
        renderRow={(r) =>
          r ? (
            <div style={grid('14rem 7rem 9rem 1fr')}>
              <div className="cell">{formatKey(r.parts)}</div>
              <div className="cell">{r.side}</div>
              <div className="cell">{r.recordNumber}</div>
              <div className="cell muted">
                {count(r.oldCount)} in old, {count(r.newCount)} in new
              </div>
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
        fetchPage={pager(client, resultId, 'emptyKey')}
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
      fetchPage={pager(client, resultId, 'warnings')}
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
  oldHeaders,
  newHeaders,
}: {
  client: CompareClient
  result: CompareResult
  oldHeaders: string[]
  newHeaders: string[]
}) {
  const { resultId } = result
  const { counts, changesByColumn } = result.summary
  const problemCounts: Record<Problem, number> = {
    ambiguous: counts.ambiguous,
    emptyKey: result.emptyKey.total,
    warnings: result.warnings.total,
  }
  const ambiguousRecordCount = result.ambiguousRecordCount
  const problemTotal = problemCounts.ambiguous + problemCounts.emptyKey + problemCounts.warnings
  const differences = counts.added + counts.removed + counts.changed
  const [tab, setTab] = useState<Tab>(() => firstRelevantTab(counts, problemTotal))
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
    <section className="panel results-panel">
      {differences === 0 && (
        <p className="note" role="status">
          No differences under the current rules.
          {problemTotal > 0 && ` ${counted(problemTotal, 'problem')} still need${problemTotal === 1 ? 's' : ''} review: see Problems.`}
        </p>
      )}
      <div className="tabs" role="tablist" aria-label="Comparison results">
        {tabs.map(([id, label, n]) => {
          const Icon = TAB_ICONS[id]
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`tab-${id}`}
              aria-controls="result-panel"
              tabIndex={tab === id ? 0 : -1}
              onKeyDown={(e) => {
                const index = tabs.findIndex(([key]) => key === id)
                const next =
                  e.key === 'ArrowRight'
                    ? (index + 1) % tabs.length
                    : e.key === 'ArrowLeft'
                      ? (index + tabs.length - 1) % tabs.length
                      : e.key === 'Home'
                        ? 0
                        : e.key === 'End'
                          ? tabs.length - 1
                          : -1
                if (next >= 0) {
                  e.preventDefault()
                  const target = tabs[next][0]
                  setTab(target)
                  document.getElementById(`tab-${target}`)?.focus()
                }
              }}
              aria-selected={tab === id}
              className={tab === id ? 'tab active' : 'tab'}
              onClick={() => setTab(id)}
            >
              <Icon size={16} />
              {label} <span className="tab-count">{count(n)}</span>
            </button>
          )
        })}
      </div>
      <div id="result-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {tab === 'added' && (
          <RecordTable key={`${resultId}-added`} client={client} resultId={resultId} tab="added" headers={newHeaders} />
        )}
        {tab === 'removed' && (
          <RecordTable
            key={`${resultId}-removed`}
            client={client}
            resultId={resultId}
            tab="removed"
            headers={oldHeaders}
          />
        )}
        {tab === 'changed' && (
          <>
            <div className="row">
              <Filter size={16} aria-hidden="true" />
              <Select
                label="Changed column"
                value={filterColumn ?? ''}
                onChange={setColumn}
                options={[
                  { value: '', label: `All changed columns (${count(counts.changed)})` },
                  ...Object.entries(changesByColumn)
                  .sort(([, a], [, b]) => b - a)
                  .map(([column, total]) => ({ value: column, label: `${column} (${count(total)})` })),
                ]}
              />
            </div>
            <ChangedTable
              key={`${resultId}-changed-${filterColumn ?? ''}`}
              client={client}
              resultId={resultId}
              column={filterColumn}
            />
          </>
        )}
        {tab === 'problems' && (
          <>
            <p className="note">
              Problems include distinct ambiguous keys, empty-key records, and individual numeric warnings. These are
              different units, not a count of unique affected records.
            </p>
            <div className="row">
              {(Object.keys(PROBLEM_LABELS) as Problem[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={problem === p}
                  className={problem === p ? 'tab active' : 'tab'}
                  onClick={() => setProblem(p)}
                >
                  {PROBLEM_LABELS[p]} ({count(problemCounts[p])}
                  {p === 'ambiguous' && problemCounts.ambiguous > 0 && ` ${noun(problemCounts.ambiguous, 'key')}, ${counted(ambiguousRecordCount, 'record')}`})
                </button>
              ))}
            </div>
            <ProblemTable key={`${resultId}-${problem}`} client={client} resultId={resultId} problem={problem} />
          </>
        )}
      </div>
      <div className="results-legend">
        <span>
          <span className="legend-swatch before-swatch" /> Before · old value
        </span>
        <span>
          <span className="legend-swatch after-swatch" /> After · new value
        </span>
        <span className="note">{RECORD_NUMBER_NOTE}</span>
      </div>
    </section>
  )
}
