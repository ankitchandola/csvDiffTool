// Writes a generated pair as old.xlsx and new.xlsx (plus the expected counts) in its own
// process, so SheetJS's memory for writing doesn't count toward the reading benchmark.
//   node --import tsx scripts/bench/write-xlsx.ts '<PairSpec JSON>' <otherSheets> <dir>
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import { generatePair, type PairSpec } from './generate'

// Cells are written as text, as an export of IDs and codes would be.
function workbook(text: string, otherSheets: number): Uint8Array {
  const rows = text.trimEnd().split('\n').map((line) => line.split(','))
  const book = XLSX.utils.book_new()
  for (let i = 0; i < otherSheets; i++) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), `Other${i + 1}`)
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Data')
  return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer)
}

const [specJson, otherSheets, dir] = process.argv.slice(2)
const pair = generatePair(JSON.parse(specJson) as PairSpec)
writeFileSync(join(dir, 'old.xlsx'), workbook(pair.oldText, Number(otherSheets)))
writeFileSync(join(dir, 'new.xlsx'), workbook(pair.newText, Number(otherSheets)))
writeFileSync(join(dir, 'expected.json'), JSON.stringify(pair.expected))
