import { DEFAULT_LIMITS, type Limits } from '../engine/limits'
import { accounting, exportOutstanding, markComplete } from './reconcile/accounting'
import { getIssues, match, normalize, parse, setOpening } from './reconcile/inputs'
import { exportReport } from './reconcile/reports'
import { decide, decideSet, getReview, getSet, inspect, pairCheck, setDecisions } from './reconcile/review'
import { createWorkspace, type Reporter } from './reconcile/workspace'
import type { ReconRequest, ReconResults } from './reconcile-protocol'

// Owns parsed sources, normalized transactions and the latest suggestions, so full data
// never crosses to the UI thread. Each request group lives in its own module under
// ./reconcile and works on one shared workspace.
export function createReconcileHandler(limits: Limits = DEFAULT_LIMITS) {
  const ws = createWorkspace(limits)
  return async function handle(request: ReconRequest, onProgress?: Reporter): Promise<ReconResults[ReconRequest['type']]> {
    switch (request.type) {
      case 'parse':
        return parse(ws, request, onProgress)
      case 'getIssues':
        return getIssues(ws, request)
      case 'setOpening':
        return setOpening(ws, request)
      case 'normalize':
        return normalize(ws, request, onProgress)
      case 'match':
        return match(ws, request, onProgress)
      case 'getReview':
        return getReview(ws, request)
      case 'setDecisions':
        return setDecisions(ws, request)
      case 'decide':
        return decide(ws, request)
      case 'checkPair':
        return pairCheck(ws, request)
      case 'getSet':
        return getSet(ws, request)
      case 'decideSet':
        return decideSet(ws, request)
      case 'inspect':
        return inspect(ws, request)
      case 'accounting':
        return accounting(ws, request)
      case 'markComplete':
        return markComplete(ws, request)
      case 'exportOutstanding':
        return exportOutstanding(ws, request)
      case 'exportReport':
        return exportReport(ws, request)
    }
  }
}
