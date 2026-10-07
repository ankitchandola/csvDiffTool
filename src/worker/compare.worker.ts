import type { Phase } from '../engine/types'
import { createHandler } from './handler'
import type { WorkerRequest } from './protocol'
import { serve } from './serve'

serve<WorkerRequest, Phase>(createHandler(), 'comparison worker')
