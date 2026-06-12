import { defineConfig, devices } from '@playwright/test'

// E2E_PORT lets parallel checkouts/worktrees run the e2e suite concurrently on
// unique ports. Without it, two suites share port 4174 and (because of
// reuseExistingServer below) silently test each other's builds. Defaults to
// the historical 4174 so CI and plain local runs are unchanged.
const PORT = Number(process.env.E2E_PORT ?? 4174)

export default defineConfig({
  testDir: './e2e',
  // Fail fast on first failure in CI
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Build the app then serve the preview server.
  // reuseExistingServer: !process.env.CI allows local runs to skip rebuild
  // when the developer already has pnpm preview running.
  webServer: {
    command: `pnpm build && pnpm preview --port ${PORT} --strictPort`,
    port: PORT,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
})
