import { defineConfig, devices } from '@playwright/test'

// Overridable so parallel checkouts/worktrees don't fight over one port
// (a stale server on a shared port serves a foreign build → phantom failures).
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
    command: `pnpm build && pnpm preview --port ${PORT}`,
    port: PORT,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
})
