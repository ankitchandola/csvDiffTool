import type { Phase } from '../engine/types'

export type Task = 'old' | 'new' | 'keys' | 'compare' | 'export'

export interface TaskProgress<P extends string = Phase> {
  phase: P
  done: number
  total: number
}

// null: started, no progress reported yet.
export type Activity<T extends string = Task, P extends string = Phase> = Partial<Record<T, TaskProgress<P> | null>>

export const TASK_LABELS: Record<Task, string> = {
  old: 'Reading old file',
  new: 'Reading new file',
  keys: 'Checking keys',
  compare: 'Comparing',
  export: 'Exporting',
}

export const PHASE_LABELS: Record<Phase, string> = {
  parse: 'parsing records',
  index: 'matching keys',
  compare: 'comparing values',
  export: 'writing the file',
}
