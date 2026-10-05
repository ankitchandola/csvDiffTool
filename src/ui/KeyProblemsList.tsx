import type { KeyProblems } from '../worker/protocol'
import { count, RECORD_NUMBER_NOTE } from './format'
import { ShowingNote } from './ShowingNote'

function parts(values: string[]) {
  return values.map((v) => JSON.stringify(v)).join(', ')
}

export function KeyProblemsList({ problems }: { problems: KeyProblems }) {
  const { ambiguous, emptyKey } = problems
  if (ambiguous.total === 0 && emptyKey.total === 0) return null
  return (
    <div className="warning">
      {ambiguous.total > 0 && (
        <>
          <h4>
            {count(ambiguous.total)} ambiguous key{ambiguous.total === 1 ? '' : 's'} (left out of the comparison on both
            sides)
          </h4>
          <ul>
            {ambiguous.items.map((a) => (
              <li key={a.encoded}>
                {a.old
                  .map((r) => `old data record ${r.recordNumber}: ${parts(r.parts)}`)
                  .concat(a.oldCount > a.old.length ? [`${count(a.oldCount - a.old.length)} more in old`] : [])
                  .concat(a.new.map((r) => `new data record ${r.recordNumber}: ${parts(r.parts)}`))
                  .concat(a.newCount > a.new.length ? [`${count(a.newCount - a.new.length)} more in new`] : [])
                  .join(' · ')}
              </li>
            ))}
          </ul>
          <ShowingNote shown={ambiguous.items.length} total={ambiguous.total} />
        </>
      )}
      {emptyKey.total > 0 && (
        <>
          <h4>
            {count(emptyKey.total)} record{emptyKey.total === 1 ? '' : 's'} with an empty key part (left out of the
            comparison)
          </h4>
          <ul>
            {emptyKey.items.map((r) => (
              <li key={`${r.side}-${r.recordNumber}`}>
                {r.side} data record {r.recordNumber}: {parts(r.parts)}
              </li>
            ))}
          </ul>
          <ShowingNote shown={emptyKey.items.length} total={emptyKey.total} />
        </>
      )}
      <p className="note">{RECORD_NUMBER_NOTE}</p>
    </div>
  )
}
