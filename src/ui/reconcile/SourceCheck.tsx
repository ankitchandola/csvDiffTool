import type { SourceDescriptor } from '../../reconciliation/session'
import { RECON_SIDES, type ReconSide } from '../../reconciliation/types'
import type { SourceInfo } from '../../worker/reconcile-protocol'
import type { FileState } from '../file-state'
import { SIDE_LABELS } from './location'

export function SourceCheck({ expected, files }: { expected: Record<ReconSide, SourceDescriptor>; files: Record<ReconSide, FileState<SourceInfo>> }) {
  const status = RECON_SIDES.map((side) => {
    const state = files[side]
    const loaded = state.status === 'ready' ? state.info.fingerprint : null
    return { side, loaded, matches: loaded === expected[side].fingerprint }
  })
  if (status.every((s) => s.matches)) return null
  return (
    <div className="warning" role="status">
      <p>The session was made from these files. Load the same files to apply its decisions; decisions about a different file will not apply.</p>
      <ul>
        {status.map(({ side, loaded, matches }) => (
          <li key={side}>
            {SIDE_LABELS[side]}: {expected[side].fileName}
            {expected[side].sheet ? ` (sheet “${expected[side].sheet}”)` : ''} —{' '}
            {matches ? 'loaded' : loaded ? 'a different file is loaded' : 'not loaded yet'}
          </li>
        ))}
      </ul>
    </div>
  )
}
