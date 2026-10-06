import type { ParseIssue } from '../engine/parse'
import type { FileFormat } from '../engine/types'
import type { FileInfo, Preview } from '../worker/protocol'

export type FileState =
  | { status: 'empty' }
  | { status: 'loading'; file: File; sheet?: string }
  | { status: 'ready'; file: File; info: FileInfo }
  | { status: 'invalid'; file: File; issues: Preview<ParseIssue>; format?: FileFormat }
  // sheet: the worksheet to read again, so recovery doesn't fall back to the first one.
  | { status: 'failed'; file: File; message: string; sheet?: string }

// The worksheet this state was reading or read, if any.
export function sheetOf(state: FileState): string | undefined {
  if (state.status === 'loading' || state.status === 'failed') return state.sheet
  const format = state.status === 'ready' ? state.info.format : state.status === 'invalid' ? state.format : undefined
  return format?.kind === 'xlsx' ? format.sheet : undefined
}
