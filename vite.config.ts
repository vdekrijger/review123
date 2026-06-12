/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    conditions: ['browser'],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.{test,spec}.ts'],
    env: {
      VITE_GITHUB_CLIENT_ID: 'test_client_id',
      VITE_GITLAB_CLIENT_ID: 'test_gitlab_client_id',
    },
  },
})
