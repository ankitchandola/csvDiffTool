import { createReconcileHandler } from './reconcile-handler'
import type { ReconPhase, ReconRequest } from './reconcile-protocol'
import { serve } from './serve'

serve<ReconRequest, ReconPhase>(createReconcileHandler(), 'reconciliation worker')
