/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    conditions: ['browser'],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // @git-diff-view (+ bundled highlight.js / lowlight) — large but stable.
          // Splitting it out improves long-term caching.
          if (
            id.includes('node_modules/@git-diff-view') ||
            id.includes('node_modules/highlight.js') ||
            id.includes('node_modules/lowlight') ||
            id.includes('node_modules/fast-diff')
          ) {
            return 'vendor-diff-view'
          }

          // posthog-js — heavyweight analytics SDK, completely stable.
          if (id.includes('node_modules/posthog-js')) {
            return 'vendor-posthog'
          }

          // marked + DOMPurify — markdown rendering pipeline.
          if (
            id.includes('node_modules/marked') ||
            id.includes('node_modules/dompurify')
          ) {
            return 'vendor-markdown'
          }
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    // Process CSS through the Vite pipeline so `?raw` imports of stylesheets
    // (design-system-primitives.test.ts) return real file contents instead of
    // vitest's default empty-module CSS stub.
    css: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.{test,spec}.ts', 'api/**/*.{test,spec}.ts'],
    env: {
      VITE_GITHUB_CLIENT_ID: 'test_client_id',
      VITE_GITLAB_CLIENT_ID: 'test_gitlab_client_id',
    },
  },
})
