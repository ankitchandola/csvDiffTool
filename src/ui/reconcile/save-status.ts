export type StorageState =
  | { kind: 'off' }
  | { kind: 'saving' }
  | { kind: 'saved'; revision: number }
  // lastSaved: the last revision actually written, if any.
  | { kind: 'error'; message: string; lastSaved: number | null }

export function storageText(state: StorageState, revision: number): string {
  switch (state.kind) {
    case 'off':
      return 'Not saved in this browser'
    case 'saving':
      return 'Saving in this browser…'
    case 'saved':
      return state.revision === revision ? 'Saved in this browser' : `Saved in this browser at revision ${state.revision}`
    case 'error':
      return `Not saved: ${state.message}${state.lastSaved === null ? '' : ` (last saved revision ${state.lastSaved})`}`
  }
}

export function backupText(backupRevision: number | null, revision: number): string {
  if (backupRevision === null) return 'No backup'
  return backupRevision === revision ? `Backup at revision ${backupRevision}` : `Backup at revision ${backupRevision}, outdated`
}

// Until the browser holds this revision or a backup includes it, a reload loses it.
export function atRisk(state: StorageState, backupRevision: number | null, revision: number): boolean {
  return !(state.kind === 'saved' && state.revision === revision) && backupRevision !== revision
}
