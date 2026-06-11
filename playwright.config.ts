import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // Fail fast on first failure in CI
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],

  use: {
    baseURL: 'http://localhost:4174',
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
    command: 'pnpm build && pnpm preview --port 4174',
    port: 4174,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
})
