import type { Activity } from './activity'

export function ActivityBar<T extends string, P extends string>({
  activity,
  onCancel,
  taskLabels,
  phaseLabels,
}: {
  activity: Activity<T, P>
  onCancel: () => void
  // Also the display order.
  taskLabels: Record<T, string>
  phaseLabels: Record<P, string>
}) {
  const tasks = (Object.keys(taskLabels) as T[]).filter((task) => task in activity)
  if (tasks.length === 0) return null
  return (
    <section className="panel activity" aria-live="polite">
      {tasks.map((task) => {
        const progress = activity[task]
        const percent = progress && progress.total > 0 ? Math.floor((progress.done / progress.total) * 100) : null
        return (
          <div key={task} className="activity-row">
            <span>
              {taskLabels[task]}
              {progress && ` — ${phaseLabels[progress.phase]}`}
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
