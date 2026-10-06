import type { Phase } from '../engine/types'
import type { Progress } from '../worker/protocol'

export type Task = 'old' | 'new' | 'keys' | 'compare' | 'export'

// null: started, no progress reported yet.
export type Activity = Partial<Record<Task, Progress | null>>

const TASK_LABELS: Record<Task, string> = {
  old: 'Reading old file',
  new: 'Reading new file',
  keys: 'Checking keys',
  compare: 'Comparing',
  export: 'Exporting',
}

const PHASE_LABELS: Record<Phase, string> = {
  parse: 'parsing records',
  index: 'matching keys',
  compare: 'comparing values',
  export: 'writing the file',
}

export function ActivityBar({ activity, onCancel }: { activity: Activity; onCancel: () => void }) {
  const tasks = (Object.keys(TASK_LABELS) as Task[]).filter((task) => task in activity)
  if (tasks.length === 0) return null
  return (
    <section className="panel activity" aria-live="polite">
      {tasks.map((task) => {
        const progress = activity[task]
        const percent = progress && progress.total > 0 ? Math.floor((progress.done / progress.total) * 100) : null
        return (
          <div key={task} className="activity-row">
            <span>
              {TASK_LABELS[task]}
              {progress && ` — ${PHASE_LABELS[progress.phase]}`}
              {percent !== null && ` ${percent}%`}
            </span>
            <progress max={100} value={percent ?? undefined} />
          </div>
        )
      })}
      <button type="button" className="secondary" onClick={onCancel}>
        Cancel
      </button>
      <p className="note">
        Cancelling stops all work in progress. You will need to explicitly read your files again to continue.
      </p>
    </section>
  )
}
