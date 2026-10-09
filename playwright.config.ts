import { defineConfig, devices } from '@playwright/test'

// Chrome runs everything. Firefox and WebKit (Safari's engine) run too with
// ALL_BROWSERS=1: npm run test:ui:browsers.
const others = process.env.ALL_BROWSERS
  ? [
      { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } } },
      { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } } },
    ]
  : []

// BASE_URL runs the suite against a deployed copy instead of a local dev server, for
// example BASE_URL=https://ankitchandola.github.io/csvDiffTool/ npm run test:ui.
const deployed = process.env.BASE_URL

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // Several tests read 600,000-row files; in parallel runs the lighter ones slow down too.
  timeout: 60_000,
  use: {
    baseURL: deployed ?? 'http://127.0.0.1:4175/',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chrome', use: { channel: 'chrome' } }, ...others],
  webServer: deployed
    ? undefined
    : {
        command: 'npm run dev -- --host 127.0.0.1 --port 4175 --strictPort',
        url: 'http://127.0.0.1:4175',
        reuseExistingServer: false,
      },
})
