export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

export function jsonBlob(text: string): Blob {
  return new Blob([text], { type: 'application/json' })
}
