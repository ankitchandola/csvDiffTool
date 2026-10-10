// Runs the worker handler (the same code the browser worker runs) on generated file pairs
// and reports time and memory per stage. Every run also checks the comparison counts
// against the generator's known answer.
//
//   npm run bench               full matrix
//   npm run bench -- --quick    small matrix, for checking the script itself
//   npm run bench -- --write    also write docs/benchmark-results.md
//   npm run bench -- --only="xlsx wide"  one named scenario, in a fresh process (see Max RSS)
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { getHeapStatistics } from 'node:v8'
import type { Phase } from '../../src/engine/types'
import { DEFAULT_LIMITS } from '../../src/engine/limits'
import { createHandler } from '../../src/worker/handler'
import { type GeneratedPair, generatePair, type PairSpec } from './generate'

const gc = (globalThis as { gc?: () => void }).gc
if (!gc) throw new Error('Run with node --expose-gc (npm run bench does this)')
const collect = gc

const MB = 2 ** 20
const RULES = { delimiter: 'auto', trimHeaders: true } as const

interface Scenario {
  name: string
  spec: Omit<PairSpec, 'seed' | 'addRatio' | 'removeRatio'>
  // Write each file as an .xlsx whose compared sheet "Data" follows this many other sheets of the same size.
  xlsx?: { otherSheets: number }
}

const BASE = { columns: 10, fieldLength: 12, changeRatio: 0.05 }

const FULL: Scenario[] = [
  ...[10_000, 100_000, 250_000, 500_000, 1_000_000].map((rows) => ({ name: 'rows', spec: { ...BASE, rows } })),
  ...[5, 20, 50].map((columns) => ({ name: 'width', spec: { ...BASE, rows: 100_000, columns } })),
  ...[4, 64].map((fieldLength) => ({ name: 'field length', spec: { ...BASE, rows: 100_000, fieldLength } })),
  ...[0.01, 0.9].map((changeRatio) => ({ name: 'change ratio', spec: { ...BASE, rows: 250_000, changeRatio } })),
  { name: 'xlsx', spec: { ...BASE, rows: 100_000 }, xlsx: { otherSheets: 0 } },
  { name: 'xlsx wide', spec: { ...BASE, rows: 100_000, columns: 50 }, xlsx: { otherSheets: 0 } },
  { name: 'xlsx 4 sheets', spec: { ...BASE, rows: 100_000 }, xlsx: { otherSheets: 3 } },
  // About 940,000 .xlsx export cells, just under the export cap. A result near an .xlsx
  // sheet's 1,048,575-row limit (about 5.7 million cells) ran out of Node's 4 GB heap.
  { name: 'xlsx export at cell cap', spec: { ...BASE, rows: 160_000, changeRatio: 0.9 } },
  // Same cells, but one-character values: few distinct strings for the shared-string table.
  { name: 'xlsx export repeated text', spec: { ...BASE, rows: 160_000, changeRatio: 0.9, fieldLength: 1 } },
  // Mostly unique 64-character values.
  { name: 'xlsx export unique text', spec: { ...BASE, rows: 100_000, changeRatio: 0.9, fieldLength: 64 } },
  // Few cells, long unique values: isolates the cost of text from the cost of cells.
  { name: 'xlsx export long text', spec: { ...BASE, rows: 20_000, changeRatio: 0.9, fieldLength: 1000 } },
]

const QUICK: Scenario[] = [
  { name: 'rows', spec: { ...BASE, rows: 10_000 } },
  { name: 'change ratio', spec: { ...BASE, rows: 10_000, changeRatio: 0.9 } },
  { name: 'xlsx 2 sheets', spec: { ...BASE, rows: 10_000 }, xlsx: { otherSheets: 1 } },
]

function csvPair(spec: PairSpec) {
  const pair = generatePair(spec)
  return { oldFile: new File([pair.oldText], 'old.csv'), newFile: new File([pair.newText], 'new.csv'), expected: pair.expected }
}

function xlsxPair(spec: PairSpec, otherSheets: number) {
  const dir = mkdtempSync(join(tmpdir(), 'recon-desk-bench-'))
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/bench/write-xlsx.ts', JSON.stringify(spec), String(otherSheets), dir])
  const read = (name: string) => new File([readFileSync(join(dir, name))], name)
  const files = { oldFile: read('old.xlsx'), newFile: read('new.xlsx') }
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as GeneratedPair['expected']
  rmSync(dir, { recursive: true })
  return { ...files, expected }
}

function memory(): number {
  const m = process.memoryUsage()
  return m.heapUsed + m.external
}

interface Stage {
  ms: number
  peak: number
  retained: number
}

// Peak is sampled at each progress report (every 2,048 records) and at the end, so it
// is a lower bound on the true peak; retained is measured after a forced GC. .xlsx parsing
// reports progress only at the end, so for it Max RSS (the process's high-water mark so far)
// is the better peak; run one scenario per process (--only=) to read it per scenario.
async function measure<T>(baseline: number, run: (sample: () => void) => Promise<T>): Promise<[T, Stage]> {
  collect()
  let peak = memory()
  const sample = () => {
    peak = Math.max(peak, memory())
  }
  const start = performance.now()
  const result = await run(sample)
  sample()
  const ms = performance.now() - start
  collect()
  return [result, { ms, peak: peak - baseline, retained: memory() - baseline }]
}

interface Row {
  scenario: Scenario
  inputMB: number
  parseMs: number
  indexMs: number
  compareMs: number
  pageMs: number
  csvMs: number
  csvMB: number
  jsonMs: number
  jsonMB: number
  xlsxMs: number
  xlsxMB: number
  peakMB: number
  retainedMB: number
  maxRssMB: number
}

async function runScenario(scenario: Scenario): Promise<Row> {
  const spec: PairSpec = { ...scenario.spec, addRatio: 0.02, removeRatio: 0.02, seed: 42 }
  const { oldFile, newFile, expected } = scenario.xlsx ? xlsxPair(spec, scenario.xlsx.otherSheets) : csvPair(spec)
  const sheet = scenario.xlsx ? 'Data' : undefined
  collect()
  const baseline = memory()
  // .xlsx caps are what these runs are meant to set, so they don't apply here.
  const handle = createHandler({
    ...DEFAULT_LIMITS,
    // The .xlsx export cell cap is one of the numbers these runs are meant to set.
    maxXlsxExportCells: Infinity,
    maxXlsxExportText: Infinity,
    ...(scenario.xlsx && { maxXlsxBytes: Infinity, maxUnpackedBytes: Infinity, maxXlsxFields: Infinity }),
  })
  const stages: Stage[] = []
  const progress = (sample: () => void) => (_phase: Phase) => sample()

  const parsed = (result: unknown) => {
    const outcome = result as { ok: boolean; issues?: { items: { message: string }[] } }
    if (!outcome.ok) throw new Error(`${scenario.name}: ${outcome.issues?.items[0]?.message}`)
  }
  const [oldResult, parseOld] = await measure(baseline, (s) =>
    handle({ id: 1, type: 'parse', side: 'old', file: oldFile, rules: RULES, sheet }, progress(s)),
  )
  const [newResult, parseNew] = await measure(baseline, (s) =>
    handle({ id: 2, type: 'parse', side: 'new', file: newFile, rules: RULES, sheet }, progress(s)),
  )
  parsed(oldResult)
  parsed(newResult)
  stages.push(parseOld, parseNew)

  // diffFiles always reports the compare phase (at least once, when it finishes), so these get set.
  let indexStartedAt = 0
  let compareStartedAt = 0
  let compareEndedAt = 0
  const profile = {
    name: 'bench',
    parse: RULES,
    key: { columns: ['id'], trim: true, caseInsensitive: false },
    value: { ignoredColumns: [], trim: false, caseInsensitive: [], numeric: {} },
  }
  const [result, compare] = await measure(baseline, async (s) => {
    indexStartedAt = performance.now()
    const r = await handle({ id: 3, type: 'compare', profile }, (phase) => {
      if (phase === 'compare' && compareStartedAt === 0) compareStartedAt = performance.now()
      s()
    })
    compareEndedAt = performance.now()
    return r
  })
  stages.push(compare)
  if (!('resultId' in result)) throw new Error('compare returned no result')
  const counts = result.summary.counts
  for (const key of ['added', 'removed', 'changed', 'unchanged'] as const) {
    if (counts[key] !== expected[key]) {
      throw new Error(`${scenario.name} ${spec.rows}: ${key} was ${counts[key]}, expected ${expected[key]}`)
    }
  }
  const { resultId } = result

  const [, page] = await measure(baseline, async () => {
    for (const offset of [0, Math.floor(counts.changed / 2)]) {
      await handle({ id: 4, type: 'getRows', resultId, tab: 'changed', offset, limit: 200 })
    }
    await handle({ id: 5, type: 'getRows', resultId, tab: 'changed', offset: 0, limit: 200, column: 'col1' })
    await handle({ id: 6, type: 'getRows', resultId, tab: 'added', offset: 0, limit: 200 })
  })
  stages.push(page)

  let csvBytes = 0
  const [, csv] = await measure(baseline, async (s) => {
    const blob = await handle({ id: 7, type: 'export', resultId, format: 'csv' }, progress(s))
    csvBytes = (blob as Blob).size
  })
  let jsonBytes = 0
  const [, json] = await measure(baseline, async (s) => {
    const blob = await handle({ id: 8, type: 'export', resultId, format: 'json' }, progress(s))
    jsonBytes = (blob as Blob).size
  })
  let xlsxBytes = Number.NaN
  const [, xlsx] = await measure(baseline, async (s) => {
    try {
      const blob = await handle({ id: 9, type: 'export', resultId, format: 'xlsx' }, progress(s))
      xlsxBytes = (blob as Blob).size
    } catch (error) {
      console.error(`${scenario.name}: .xlsx export refused: ${(error as Error).message}`)
    }
  })
  stages.push(csv, json, xlsx)

  return {
    scenario,
    inputMB: (oldFile.size + newFile.size) / MB,
    parseMs: parseOld.ms + parseNew.ms,
    indexMs: compareStartedAt - indexStartedAt,
    compareMs: compareEndedAt - compareStartedAt,
    pageMs: page.ms,
    csvMs: csv.ms,
    csvMB: csvBytes / MB,
    jsonMs: json.ms,
    jsonMB: jsonBytes / MB,
    xlsxMs: Number.isNaN(xlsxBytes) ? Number.NaN : xlsx.ms,
    xlsxMB: xlsxBytes / MB,
    peakMB: Math.max(...stages.map((s) => s.peak)) / MB,
    retainedMB: compare.retained / MB,
    maxRssMB: process.resourceUsage().maxRSS / 1024,
  }
}

function table(rows: Row[]): string {
  const f = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1))
  const lines = [
    '| Varying | Rows | Cols | Field | Changed | Input MB | Parse ms | Index ms | Compare ms | Page ms | CSV ms (MB) | JSON ms (MB) | XLSX ms (MB) | Peak MB | Held MB | Max RSS MB |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const r of rows) {
    const s = r.scenario.spec
    lines.push(
      `| ${r.scenario.name} | ${s.rows.toLocaleString('en-US')} | ${s.columns} | ${s.fieldLength} | ${s.changeRatio * 100}% | ${f(r.inputMB)} | ${f(r.parseMs)} | ${f(r.indexMs)} | ${f(r.compareMs)} | ${f(r.pageMs)} | ${f(r.csvMs)} (${f(r.csvMB)}) | ${f(r.jsonMs)} (${f(r.jsonMB)}) | ${Number.isNaN(r.xlsxMs) ? 'refused' : `${f(r.xlsxMs)} (${f(r.xlsxMB)})`} | ${f(r.peakMB)} | ${f(r.retainedMB)} | ${f(r.maxRssMB)} |`,
    )
  }
  return lines.join('\n')
}

const args = new Set(process.argv.slice(2))
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length)
const scenarios = (args.has('--quick') ? QUICK : FULL).filter((s) => !only || s.name === only)
const results: Row[] = []
for (const scenario of scenarios) {
  const row = await runScenario(scenario)
  results.push(row)
  console.log(table([row]).split('\n').at(-1))
  collect()
}

const machine = `${cpus()[0].model}, ${Math.round(totalmem() / 2 ** 30)} GB RAM, Node ${process.version}, V8 heap limit ${Math.round(getHeapStatistics().heap_size_limit / MB)} MB`
console.log(`\n${machine}\n\n${table(results)}`)
if (args.has('--write')) {
  writeFileSync('docs/benchmark-results.md', `# Benchmark results\n\nGenerated by \`npm run bench -- --write\`.\n\n${machine}\n\n${table(results)}\n`)
  console.log('\nWrote docs/benchmark-results.md')
}
