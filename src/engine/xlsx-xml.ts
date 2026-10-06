import * as XLSX from 'xlsx'

// How a formula cell that SheetJS reads as empty stores its result. SheetJS gives the
// same cell for a formula with no <v> and for one with an empty <v>, so only the XML
// tells them apart.
//   none:          no <v>, or an empty value under a type that can't be empty: no result.
//   empty:         an empty <v> typed as a string (t="str"), as Excel saves "".
//   untyped-empty: an empty <v> with no type, as XlsxWriter saves "". A script that
//                  never calculated the formula can write the same thing.
export type SavedResult = 'none' | 'empty' | 'untyped-empty'

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }

function unescapeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (entity) => ENTITIES[entity])
}

function attribute(tag: string, name: string): string | undefined {
  const at = tag.indexOf(` ${name}="`)
  if (at === -1) return undefined
  const start = at + name.length + 3
  return unescapeXml(tag.slice(start, tag.indexOf('"', start)))
}

function tags(xml: string, name: string): string[] {
  const found: string[] = []
  for (let at = xml.indexOf(`<${name} `); at !== -1; at = xml.indexOf(`<${name} `, at + 1)) {
    found.push(xml.slice(at, xml.indexOf('>', at) + 1))
  }
  return found
}

function sheetPath(read: (path: string) => string | null, sheetName: string): string | null {
  const workbook = read('xl/workbook.xml')
  const rels = read('xl/_rels/workbook.xml.rels')
  if (!workbook || !rels) return null
  const sheet = tags(workbook, 'sheet').find((tag) => attribute(tag, 'name') === sheetName)
  const id = sheet && attribute(sheet, 'r:id')
  const rel = id && tags(rels, 'Relationship').find((tag) => attribute(tag, 'Id') === id)
  const target = rel && attribute(rel, 'Target')
  if (!target) return null
  return target.startsWith('/') ? target.slice(1) : `xl/${target}`
}

// Cells appear in row-major order, as refs are asked for, so each search starts where
// the last one ended: one pass over the sheet however many refs there are.
function classifyAll(xml: string, refs: string[]): Map<string, SavedResult> {
  const results = new Map<string, SavedResult>()
  let cursor = 0
  for (const ref of refs) {
    const needle = ` r="${ref}"`
    let at = xml.indexOf(needle, cursor)
    if (at === -1) at = xml.indexOf(needle)
    if (at === -1) {
      results.set(ref, 'none')
      continue
    }
    const open = xml.lastIndexOf('<c', at)
    const close = xml.indexOf('>', at)
    const end = xml[close - 1] === '/' ? close : xml.indexOf('</c>', close)
    cursor = end
    const body = xml.slice(close + 1, end)
    const empty = body.includes('<v/>') || body.includes('<v></v>')
    const type = attribute(xml.slice(open, close + 1), 't')
    results.set(ref, !empty ? 'none' : type === undefined ? 'untyped-empty' : type === 'str' ? 'empty' : 'none')
  }
  return results
}

// Unzips the workbook again, so it is only worth calling when empty formula cells exist.
// Returns null when the sheet's XML can't be found; callers treat that as no result.
export function savedResults(bytes: ArrayBuffer, sheetName: string, refs: string[]): Map<string, SavedResult> | null {
  try {
    const zip = XLSX.CFB.read(new Uint8Array(bytes), { type: 'array' })
    const read = (path: string): string | null => {
      const index = zip.FullPaths.findIndex((full: string) => full.endsWith(`/${path}`))
      const content = index === -1 ? undefined : zip.FileIndex[index].content
      return content ? new TextDecoder().decode(content as Uint8Array) : null
    }
    const path = sheetPath(read, sheetName)
    const xml = path && read(path)
    if (!xml) return null
    return classifyAll(xml, refs)
  } catch {
    return null
  }
}
