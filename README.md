# Review 1-2-3

Paste a GitHub PR URL and get a guided three-step review: **Understand → Inspect → Verdict**. The app fetches the PR metadata and full diff, walks you through each step with AI-assisted context (summary, attention hotspots, before/after architecture diagrams, and a behaviour verdict — arriving in upcoming milestones), lets you inspect every changed file in unified or side-by-side diff view, and when you are ready submits your review comment directly to GitHub. Everything runs in the browser; your tokens and keys never leave your machine.

---

## Status

**Milestone A (this code):** PR URL input → diff viewer with unified/side-by-side modes, three-step stepper shell, settings panel, PostHog analytics.

**Milestone B:** GitHub sign-in and review submission via OAuth flow (Vercel serverless function).

**Milestone C:** AI features (PR summary, hotspot highlighting, architecture diagrams, behaviour verdict) powered by a BYO DeepSeek API key.

Milestone specs and criteria matrices live in [`docs/superpowers/specs/`](docs/superpowers/specs/).

---

## Local dev

**Requires pnpm >= 10.16** (enforced by `minimumReleaseAge` supply-chain gate — see below).

```bash
pnpm install
pnpm dev
```

| Command | Purpose |
|---|---|
| `pnpm dev` | Vite dev server with HMR |
| `pnpm check` | Svelte type-check (`svelte-check`) |
| `pnpm test` | Vitest unit tests (single run) |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm build` | Production build → `dist/` |
| `pnpm preview` | Serve the production build locally |

---

## Environment variables

Set these in `.env.local` locally; configure them in the Vercel dashboard for production deployments.

| Variable | Required | Default | Description |
|---|---|---|---|
| `VITE_POSTHOG_KEY` | No | — | PostHog project API key. Analytics are disabled when absent. |
| `VITE_POSTHOG_HOST` | No | `https://us.i.posthog.com` | PostHog ingestion host. |

`.env.local` is gitignored by the `.env.*` pattern in `.gitignore`.

---

## Deploy (Vercel)

- **Framework preset:** Vite
- **Build command:** `pnpm build`
- **Output directory:** `dist/`

`vercel.json` provides a SPA fallback rewrite that sends all non-`/api/` paths to `index.html` — `/api/*` is reserved for the Milestone B OAuth serverless function.

---

## Supply-chain policy

`pnpm-workspace.yaml` sets `minimumReleaseAge: 10080` (7 days in minutes). pnpm will refuse to install any package version published less than 7 days ago, acting as a gate against fast-moving supply-chain attacks.

**Emergency override** (vetted security patch only):

```bash
pnpm install --config.minimumReleaseAge=0
```

This override is deliberate friction — using it should be an explicit, documented decision.

---

## Privacy

PostHog receives only coarse, allowlisted event metadata (see [`src/lib/analytics/analytics.ts`](src/lib/analytics/analytics.ts)). Code content, diffs, repository names, and private repo identifiers are never sent. Your GitHub PAT and DeepSeek API key are stored in `localStorage` only and are sent exclusively to their respective services.
