/// <reference types="vitest/config" />
import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Build-time provenance, captured once at config eval (which runs at build time
// — not the runtime-forbidden case). Prefer the sha Vercel injects on deploys;
// fall back to the local git short sha; fall back again to 'dev' for non-git/CI
// checkouts so the build never fails on missing git.
function resolveBuildSha(): string {
  const vercelSha = process.env.VERCEL_GIT_COMMIT_SHA
  if (vercelSha) return vercelSha.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'dev'
  }
}

const BUILD_SHA = resolveBuildSha()
const BUILD_TIME = new Date().toISOString()

export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
  // Injected for the app bundle, but NOT during `vitest` (mode === 'test'),
  // where buildInfo.ts's typeof-guard fallback ('test') keeps unit tests from
  // depending on a real git checkout.
  define:
    mode === 'test'
      ? {}
      : {
          __BUILD_SHA__: JSON.stringify(BUILD_SHA),
          __BUILD_TIME__: JSON.stringify(BUILD_TIME),
        },
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
            // jsdiff (`diff`) powers the hide-whitespace recompute and is
            // equally stable — cached with the same diff vendor chunk.
            {
              name: 'vendor-diff-view',
              test: /node_modules[\\/](@git-diff-view[\\/]|highlight\.js[\\/]|lowlight[\\/]|fast-diff[\\/]|diff[\\/])/,
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
}))
