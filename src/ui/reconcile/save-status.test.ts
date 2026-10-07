import { describe, expect, it } from 'vitest'
import { atRisk, backupText, storageText } from './save-status'

describe('save status', () => {
  it('reports browser storage and backup independently', () => {
    expect(`${storageText({ kind: 'saved', revision: 12 }, 12)} · ${backupText(12, 12)}`).toBe('Saved in this browser · Backup at revision 12')
    expect(`${storageText({ kind: 'saved', revision: 13 }, 13)} · ${backupText(12, 13)}`).toBe('Saved in this browser · Backup at revision 12, outdated')
  })

  it('keeps the last saved revision visible after a failure', () => {
    expect(storageText({ kind: 'error', message: 'quota exceeded', lastSaved: 11 }, 13)).toBe('Not saved: quota exceeded (last saved revision 11)')
  })

  it('marks a revision at risk until browser storage or a backup holds it', () => {
    expect(atRisk({ kind: 'off' }, null, 1)).toBe(true)
    expect(atRisk({ kind: 'off' }, 1, 1)).toBe(false)
    expect(atRisk({ kind: 'saved', revision: 2 }, 1, 2)).toBe(false)
    expect(atRisk({ kind: 'saved', revision: 1 }, null, 2)).toBe(true)
  })
})
