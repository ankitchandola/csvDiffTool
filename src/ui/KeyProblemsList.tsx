import type { KeyProblems } from '../worker/protocol'

function parts(values: string[]) {
  return values.map((v) => JSON.stringify(v)).join(', ')
}

export function KeyProblemsList({
  problems,
  ambiguousCount,
  emptyKeyCount,
}: {
  problems: KeyProblems
  ambiguousCount: number
  emptyKeyCount: number
}) {
  if (ambiguousCount === 0 && emptyKeyCount === 0) return null
  return (
    <div className="warning">
      {ambiguousCount > 0 && (
        <>
          <h4>
            {ambiguousCount} ambiguous key{ambiguousCount === 1 ? '' : 's'} (left out of the comparison on both sides)
          </h4>
          <ul>
            {problems.ambiguous.map((a) => (
              <li key={a.encoded}>
                {a.old
                  .map((r) => `old record ${r.recordNumber}: ${parts(r.parts)}`)
                  .concat(a.oldCount > a.old.length ? [`${a.oldCount - a.old.length} more in old`] : [])
                  .concat(a.new.map((r) => `new record ${r.recordNumber}: ${parts(r.parts)}`))
                  .concat(a.newCount > a.new.length ? [`${a.newCount - a.new.length} more in new`] : [])
                  .join(' · ')}
              </li>
            ))}
          </ul>
          {ambiguousCount > problems.ambiguous.length && <p>Showing the first {problems.ambiguous.length}.</p>}
        </>
      )}
      {emptyKeyCount > 0 && (
        <>
          <h4>
            {emptyKeyCount} record{emptyKeyCount === 1 ? '' : 's'} with an empty key part (left out of the comparison)
          </h4>
          <ul>
            {problems.emptyKey.map((r) => (
              <li key={`${r.side}-${r.recordNumber}`}>
                {r.side} record {r.recordNumber}: {parts(r.parts)}
              </li>
            ))}
          </ul>
          {emptyKeyCount > problems.emptyKey.length && <p>Showing the first {problems.emptyKey.length}.</p>}
        </>
      )}
    </div>
  )
}
