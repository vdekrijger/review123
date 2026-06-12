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
        // Rolldown (Vite 8) advancedChunks — successor to manualChunks.
        // Groups are matched in array order, and a matched module's dependency
        // subtree is captured into the same group unless an EARLIER group
        // claims it. With the previous manualChunks function the svelte
        // runtime (shared by the entry and by @git-diff-view/svelte) was
        // captured into vendor-diff-view, which dragged the whole diff view —
        // including the lowlight/highlight.js syntax-highlight engine — into
        // the entry's static import graph and would defeat the lazy-loading
        // of the Review route.
        advancedChunks: {
          groups: [
            // Svelte runtime FIRST so no vendor chunk swallows it.
            { name: 'vendor-svelte', test: /node_modules[\\/]svelte[\\/]/ },

            // @git-diff-view (+ bundled highlight.js / lowlight syntax
            // engine) — large but stable, only loaded with the lazy Review
            // route. Splitting it out improves long-term caching.
            {
              name: 'vendor-diff-view',
              test: /node_modules[\\/](@git-diff-view[\\/]|highlight\.js[\\/]|lowlight[\\/]|fast-diff[\\/])/,
            },

            // posthog-js — heavyweight analytics SDK, completely stable.
            { name: 'vendor-posthog', test: /node_modules[\\/]posthog-js[\\/]/ },

            // marked + DOMPurify — markdown rendering pipeline.
            { name: 'vendor-markdown', test: /node_modules[\\/](marked|dompurify)[\\/]/ },
          ],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.{test,spec}.ts', 'api/**/*.{test,spec}.ts'],
    env: {
      VITE_GITHUB_CLIENT_ID: 'test_client_id',
      VITE_GITLAB_CLIENT_ID: 'test_gitlab_client_id',
    },
  },
})
