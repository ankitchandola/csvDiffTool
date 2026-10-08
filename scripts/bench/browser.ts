// Shared by the browser benchmarks: a production preview server, Chrome process-tree
// memory sampling, and the scroll-safe dropdown choice the end-to-end tests also use.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import type { Page } from '@playwright/test'

export const PORT = 4177
export const URL = `http://127.0.0.1:${PORT}/`

export function processTreeRss(root: number): number {
  const lines = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=']).toString().trim().split('\n')
  const children = new Map<number, number[]>()
  const rss = new Map<number, number>()
  for (const line of lines) {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number)
    rss.set(pid, kb * 1024)
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }
  let total = 0
  const stack = [root]
  while (stack.length > 0) {
    const pid = stack.pop() as number
    total += rss.get(pid) ?? 0
    stack.push(...(children.get(pid) ?? []))
  }
  return total
}

export function sampler(root: number) {
  let peak = 0
  const timer = setInterval(() => {
    peak = Math.max(peak, processTreeRss(root))
  }, 50)
  return {
    stop() {
      clearInterval(timer)
      return Math.max(peak, processTreeRss(root))
    },
  }
}

export async function choose(page: Page, label: string, option: string) {
  const trigger = page.getByRole('combobox', { name: label, exact: true })
  await trigger.scrollIntoViewIfNeeded()
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await trigger.click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

export async function startPreview(): Promise<ChildProcess> {
  const server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(URL)).ok) return server
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  server.kill()
  throw new Error('vite preview did not start; run npm run build first')
}
