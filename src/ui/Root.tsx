import { useState } from 'react'
import { App } from './App'
import { AppHeader } from './AppHeader'
import type { Mode } from './mode'
import { ReconcileApp } from './reconcile/ReconcileApp'

// Both modes stay mounted once opened, so switching keeps each one's files and settings.
export function Root() {
  const [mode, setMode] = useState<Mode>('compare')
  const [reconcileOpened, setReconcileOpened] = useState(false)
  return (
    <>
      <AppHeader
        mode={mode}
        onModeChange={(next) => {
          if (next === 'reconcile') setReconcileOpened(true)
          setMode(next)
        }}
      />
      <div hidden={mode !== 'compare'}>
        <App />
      </div>
      {reconcileOpened && (
        <div hidden={mode !== 'reconcile'}>
          <ReconcileApp />
        </div>
      )}
    </>
  )
}
