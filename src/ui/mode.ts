export type Mode = 'compare' | 'reconcile'

export const WORKSPACE_IDS: Record<Mode, string> = { compare: 'workspace', reconcile: 'reconcile-workspace' }
