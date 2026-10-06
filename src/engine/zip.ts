const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_FILE_HEADER = 0x02014b50
const END_RECORD_SIZE = 22
const MAX_COMMENT = 0xffff
const ZIP64_MARKER = 0xffffffff

function findEndRecord(view: DataView): number | null {
  const lowest = Math.max(0, view.byteLength - END_RECORD_SIZE - MAX_COMMENT)
  for (let p = view.byteLength - END_RECORD_SIZE; p >= lowest; p--) {
    if (view.getUint32(p, true) === END_OF_CENTRAL_DIRECTORY) return p
  }
  return null
}

// Adds up the uncompressed sizes the zip's central directory lists, without inflating
// anything, so a zip bomb is refused before a library unpacks it. Returns null when the
// bytes aren't a readable zip, and Infinity for ZIP64 archives (over 4 GiB unpacked per entry).
export function unpackedSize(bytes: ArrayBuffer): number | null {
  const view = new DataView(bytes)
  const end = findEndRecord(view)
  if (end === null) return null
  const entries = view.getUint16(end + 10, true)
  let p = view.getUint32(end + 16, true)
  let total = 0
  for (let i = 0; i < entries; i++) {
    if (p + 46 > view.byteLength || view.getUint32(p, true) !== CENTRAL_FILE_HEADER) return null
    const size = view.getUint32(p + 24, true)
    if (size === ZIP64_MARKER) return Infinity
    total += size
    p += 46 + view.getUint16(p + 28, true) + view.getUint16(p + 30, true) + view.getUint16(p + 32, true)
  }
  return total
}
