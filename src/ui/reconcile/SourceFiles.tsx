import type { Layout, ParseIssue } from '../../engine/parse'
import { RECON_SIDES, type ReconSide } from '../../reconciliation/types'
import type { SourceInfo } from '../../worker/reconcile-protocol'
import type { FileState } from '../file-state'
import { FilePanel } from '../FilePanel'
import { counted } from '../format'
import type { Page } from '../results/page-loader'
import { Select } from '../Select'
import type { MappingDraft } from './mapping-draft'
import { NumberField } from './NumberField'
import { SOURCE_TITLES } from './location'

function SkippedRecords({ info }: { info: SourceInfo }) {
  const { before, afterHeader, after } = info.skipped
  if (before.total + afterHeader.total + after.total === 0) return null
  return (
    <details className="preview-disclosure">
      <summary>
        Skipped {counted(before.total, 'record')} above the header{afterHeader.total > 0 && `, ${counted(afterHeader.total, 'record')} right below it`} and{' '}
        {counted(after.total, 'record')} at the end
      </summary>
      <p className="note">Skipped records are not read as transactions or balances.</p>
      {before.items.length > 0 && <pre className="skipped">{before.items.join('\n')}</pre>}
      {afterHeader.items.length > 0 && <pre className="skipped">{afterHeader.items.join('\n')}</pre>}
      {after.items.length > 0 && <pre className="skipped">{after.items.join('\n')}</pre>}
    </details>
  )
}

export function SourceFiles({
  files,
  drafts,
  onPick,
  onChangeReading,
  fetchIssues,
}: {
  files: Record<ReconSide, FileState<SourceInfo>>
  drafts: Record<ReconSide, MappingDraft>
  onPick: (side: ReconSide, file: File, draft: MappingDraft, sheet?: string) => void
  onChangeReading: (side: ReconSide, change: Partial<Pick<MappingDraft, 'delimiter'>> & { layout?: Layout }) => void
  fetchIssues: (side: ReconSide, offset: number, limit: number) => Promise<Page<ParseIssue>>
}) {
  return (
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
              onPick={(file, sheet) => onPick(side, file, draft, sheet)}
              onPickSheet={(sheet) => {
                if (state.status !== 'empty') onPick(side, state.file, draft, sheet)
              }}
              fetchIssues={(offset, limit) => fetchIssues(side, offset, limit)}
            >
              <details className="optional-fields layout-details" open={state.status === 'invalid' ? true : undefined}>
                <summary>
                  Statement layout
                  <span className="muted">
                    {' '}
                    · header on record {draft.layout.headerRecord}, skip {draft.layout.skipLeading} below it and {draft.layout.skipTrailing} at the end
                  </span>
                </summary>
              <div className="layout-fields">
                <NumberField
                  label="Header is record"
                  value={draft.layout.headerRecord}
                  min={1}
                  onCommit={(headerRecord) => onChangeReading(side, { layout: { ...draft.layout, headerRecord } })}
                />
                <NumberField
                  label="Skip records after the header"
                  value={draft.layout.skipLeading}
                  min={0}
                  onCommit={(skipLeading) => onChangeReading(side, { layout: { ...draft.layout, skipLeading } })}
                />
                <NumberField
                  label="Skip records at the end"
                  value={draft.layout.skipTrailing}
                  min={0}
                  onCommit={(skipTrailing) => onChangeReading(side, { layout: { ...draft.layout, skipTrailing } })}
                />
                <div className="field">
                  <span>CSV delimiter</span>
                  <Select<MappingDraft['delimiter']>
                    label={`${SOURCE_TITLES[side].title} CSV delimiter`}
                    value={draft.delimiter}
                    onChange={(delimiter) => onChangeReading(side, { delimiter })}
                    options={[
                      { value: 'auto', label: 'Detect automatically' },
                      { value: ',', label: 'Comma' },
                      { value: ';', label: 'Semicolon' },
                      { value: '\t', label: 'Tab' },
                    ]}
                  />
                </div>
              </div>
              <p className="note">Records are counted without blank lines. Use these when account details sit above the table, an opening-balance line sits right below the header, or totals sit below it.</p>
              </details>
              {state.status === 'ready' && <SkippedRecords info={state.info} />}
            </FilePanel>
          )
        })}
      </div>
    </section>
  )
}
