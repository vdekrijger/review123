# Review 1-2-3

Paste a GitHub, GitLab, or Bitbucket pull request URL and get a guided three-step review: **Understand → Inspect → Verdict**. The app fetches the PR/MR metadata and full diff, walks you through each step with AI-assisted context (summary, attention hotspots, before/after architecture diagrams, and a behaviour verdict), lets you inspect every changed file in unified or side-by-side diff view, and when you are ready submits your review comment directly to the hosting platform. Everything runs in the browser; your tokens and keys never leave your machine.

---

## AI features (Milestone C + D)

Review 1-2-3 adds AI-assisted panels to the **Understand** step and smart workflow tools to the **Inspect** and **Verdict** steps, all powered by a BYO [DeepSeek](https://platform.deepseek.com/) API key. No key, no AI calls — the rest of the review flow works without it.

### BYO DeepSeek key

1. Obtain a key from [platform.deepseek.com](https://platform.deepseek.com/).
2. Open **Settings** (gear icon, top-right) and paste the key in the **DeepSeek API key** field.
3. The key is stored in `localStorage` only and is sent exclusively to `api.deepseek.com` — it never leaves your browser to any intermediate server.

### What gets sent to DeepSeek

For each PR you review, up to five structured prompts are sent:

| Panel | Task | Transmission |
|---|---|---|
| **Summary** | Streaming plain-text overview + suggested reading order | Patch text for changed files (within the token budget) |
| **Attention** | Hotspots (high/medium/low) + inferred test gaps | Same packed context as above |
| **Diagrams** | Before/after architecture graph + change-map overlay (JSON, converted to Mermaid client-side) | Same packed context |
| **Verdict** | 3-level behaviour verdict (preserved/minor/significant) + evidence | Same packed context + CI failure names & annotations |
| **Test insight** | AI-inferred test coverage — which behaviors are tested and what gaps remain | Same packed context |

The packed context includes file patches and, when they fit within the token budget (~58 000 tokens for `deepseek-chat`), the full before/after file contents. Lock files (`pnpm-lock.yaml`, `package-lock.json`, etc.) and minified/generated files are excluded automatically.

**What is NOT sent:** repository names, PR titles, PR numbers, your GitHub token, any reviewer identity, or PostHog analytics data.

### Consent gate for private repositories

When you open a pull request from a **private repository**, a one-time consent dialog appears before any AI call is made. It tells you exactly what will be sent (code from that repository) and to whom (DeepSeek). You can accept (persisted per-repo in `localStorage`) or decline (AI panels show a "declined" state; manual review is unaffected). Closing or refreshing without accepting treats it as a decline.

Public repositories skip the gate entirely.

### Zero-token revisits via caching

AI results are cached in IndexedDB keyed by `owner/repo#number@headSha + task + promptVersion`. Revisiting the same PR after the head SHA has not changed costs zero tokens. When the PR gets new commits the cache key changes and the panels re-run automatically.

---

## Plan D features (Milestone D)

### Change map (status-aware diagrams)

The **Diagrams** panel now renders a **Change Map** as the primary view when AI analysis completes. Each node and edge is colour-coded: *Added* (green), *Removed* (red), *Changed* (amber), *Unchanged* (grey). A "Before / After" toggle reveals the traditional side-by-side graphs for deeper comparison.

### Test insight panel

The **At-a-Glance** card in the Understand step shows a **tests chip** summarising AI-inferred test coverage: how many behaviors have corresponding test changes and how many appear to be gaps. Opening the "Test coverage (AI-inferred)" panel shows the full checklist with behavior descriptions, test names, and file links. Coverage is inferred by reading the code — not measured instrumentation.

### Viewed state

In the **Inspect** step each file header has a **Viewed** checkbox. Marking a file viewed collapses its diff and persists the state across page reloads (stored in `localStorage` under `review123:viewed`). If the file's patch changes after you marked it viewed, an amber "Changed since you viewed it" badge appears. The sticky bar at the bottom shows `viewed N/M` so you can track progress.

### Since-last-visit interdiff

When you return to a PR whose head SHA has changed since your last visit, a banner appears in the **Inspect** step offering **"Show only changes since then"**. Clicking it fetches the GitHub compare API (`base...head`) and shows only the files that changed between your last visit and now. "Show full diff" exits compare mode. If the previous revision was force-pushed away the app shows a graceful error message.

### Comment coach

In the **Verdict** step, when you have one or more drafted comments and a DeepSeek key is configured, a **"Coach my comments"** button appears. Clicking it sends your draft bodies to DeepSeek and receives a review for each: clarity (1–5 stars), actionability, tone (ok / blunt / harsh), an optional anti-bias question, and an optional rewrite suggestion. Clicking **Apply** replaces the draft body with the suggestion. Clicking **Dismiss** hides the card. The coach result is never cached — each click makes a fresh call.

---

## Status

**Milestone A:** PR URL input → diff viewer with unified/side-by-side modes, three-step stepper shell, settings panel, PostHog analytics.

**Milestone B:** GitHub sign-in and review submission via OAuth flow (Vercel serverless function).

**Milestone C:** AI features (PR summary, hotspot highlighting, architecture diagrams, behaviour verdict) powered by a BYO DeepSeek API key.

**Milestone D:** Review intelligence — status-aware change-map diagrams, AI-inferred test insight panel, viewed-file state with persistence, since-last-visit interdiff banner, and comment coach with apply/dismiss.

**Milestone E:** Multi-provider support — GitLab merge requests and Bitbucket Cloud pull requests use the same 1-2-3 flow. Provider-qualified storage keys, non-atomic submission copy in the Verdict step, and Bitbucket/GitLab auth fields in Settings.

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
| `VITE_POSTHOG_HOST` | No | `https://us.i.posthog.com` | PostHog ingestion host. Use `https://eu.i.posthog.com` for EU data residency. |
| `VITE_GITHUB_CLIENT_ID` | No | — | GitHub OAuth App client ID (build-time, public). Sign-in button is hidden when absent. |
| `GITHUB_OAUTH_CLIENT_ID` | No | — | GitHub OAuth App client ID (server-side, Vercel only). Required for OAuth sign-in. |
| `GITHUB_OAUTH_CLIENT_SECRET` | No | — | GitHub OAuth App client secret (server-side, Vercel only). Never exposed to the browser. |

`.env.local` is gitignored by the `.env.*` pattern in `.gitignore`.

---

## GitHub OAuth setup

To enable "Sign in with GitHub" you need a GitHub OAuth App and a Vercel deployment.

### 1. Register an OAuth App

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Set **Homepage URL** to your Vercel deployment URL (e.g. `https://review123.vercel.app`).
3. Set **Authorization callback URL** to `https://<your-domain>/auth/callback`.
4. Click **Register application**, then note the **Client ID** and generate a **Client secret**.

### 2. Configure environment variables

**In Vercel** (dashboard → project → Settings → Environment Variables):

| Variable | Value |
|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | Your OAuth App client ID |
| `GITHUB_OAUTH_CLIENT_SECRET` | Your OAuth App client secret |
| `VITE_GITHUB_CLIENT_ID` | Your OAuth App client ID (same value — needed at build time) |

**Locally** — two options:

- **PAT fallback (recommended for local dev):** Set your GitHub Personal Access Token in the app's Settings panel. No OAuth config needed locally.
- **Full OAuth via `vercel dev`:** Run `vercel dev` instead of `pnpm dev`. It picks up environment variables from Vercel and routes `/api/*` to the serverless functions, giving you a full OAuth round-trip locally.

When `VITE_GITHUB_CLIENT_ID` is absent the Sign-in button is hidden and the app works in PAT-only mode — forks and local dev work with zero OAuth setup.

---

## GitLab setup

Review 1-2-3 supports GitLab merge requests natively. Authentication uses a Personal Access Token (PAT).

### Create a GitLab PAT

1. Go to **GitLab → User Settings → Access Tokens** (or your GitLab instance's equivalent).
2. Click **Add new token**.
3. Give it a name (e.g. "review123"), set an expiry, and select the **`api`** scope.
4. Click **Create personal access token** and copy the token (it starts with `glpat_`).
5. Open the app **Settings** panel (gear icon), expand **Advanced**, paste the token in **GitLab token (PAT)**, and save.

The token is stored in `localStorage` only and sent exclusively to `https://gitlab.com/api/v4`. It never leaves your browser to any intermediate server.

### What is supported on GitLab

| Feature | Supported |
|---|---|
| MR metadata and description | Yes |
| Full diff (paginated, including subgroups) | Yes |
| Inline review comments | Yes |
| MR approval | Yes |
| CI pipelines and job status | Yes |
| Resolved thread markers | Yes |
| Revision comparison (commit picker) | Yes |
| Inline code suggestions (`suggestion:-0+0` fence) | Yes |
| **Atomic review submission** | **No** — each comment is posted individually; see below |

**Submission semantics:** GitLab has no batched review API. When you click **Submit review**, the app posts each inline comment as a separate discussion, then optionally posts the overall body as a note, then approves or requests changes. The verdict step shows a notice explaining this. If some comments fail to post, the error message lists which ones — your drafts are not cleared so you can retry.

---

## Bitbucket setup

Review 1-2-3 supports Bitbucket Cloud pull requests. Authentication uses your Bitbucket email address and an App password (API token).

### Create a Bitbucket App password

1. Go to **Bitbucket → Personal settings → App passwords** (direct link: `https://bitbucket.org/account/settings/app-passwords/`).
2. Click **Create app password**.
3. Give it a label (e.g. "review123") and select the **Pull requests: Read** and **Pull requests: Write** permissions.
4. Click **Create** and copy the password.
5. Open the app **Settings** panel, expand **Advanced**, and fill in:
   - **Bitbucket email** — your Bitbucket account email
   - **Bitbucket API token** — the app password you just created
6. Click **Save**.

Both fields are stored in `localStorage` only and sent exclusively to `https://api.bitbucket.org`. They never leave your browser.

### What is supported on Bitbucket

| Feature | Supported |
|---|---|
| PR metadata and description | Yes |
| Full diff (diffstat + raw unified diff) | Yes |
| Inline review comments | Yes |
| PR approval | Yes |
| PR request-changes | Yes |
| Build/CI status | Yes |
| **Resolved thread markers** | **No** — Bitbucket does not surface resolved state via API |
| **Revision comparison (commit picker)** | **No** — compare API not supported in v1 |
| **Inline code suggestions** | **No** — Bitbucket does not support suggestion fences |
| **Atomic review submission** | **No** — each comment is posted individually; see below |

**Submission semantics:** Same as GitLab — no batched review API. Each inline comment is posted individually. The verdict step shows a notice. Partial failures list the failed comments without clearing your drafts.

---

## Provider capability comparison

| Capability | GitHub | GitLab | Bitbucket |
|---|---|---|---|
| Inline comments | Yes | Yes | Yes |
| Approval | Yes | Yes | Yes |
| Request changes | Yes | Note-based | Yes |
| CI status | Yes | Yes | Yes |
| Resolved thread markers | Yes | Yes | No |
| Revision comparison | Yes | Yes | No |
| Inline code suggestions | Yes (` ```suggestion `) | Yes (` ```suggestion:-0+0 `) | No |
| Atomic review submission | Yes | No | No |

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

## Troubleshooting

### "Resource not accessible by integration" / 403 on review submission

If your review submission fails with a permission error, the organization may restrict OAuth app access.

1. **Check or request org access for the OAuth app** — visit the app's connections page and click **Request** (or **Grant** if you are an org admin): `https://github.com/settings/connections/applications/<your-oauth-client-id>`. The app shows a direct link to this page in the error message when a Client ID is configured.
2. **PAT workaround** — if you cannot obtain org approval, generate a fine-grained Personal Access Token scoped to the repository (Settings → Advanced in the app) and paste it in the app's Settings panel. Fine-grained PATs are not subject to org OAuth-app policies.

---

## Privacy

PostHog receives only coarse, allowlisted event metadata (see [`src/lib/analytics/analytics.ts`](src/lib/analytics/analytics.ts)). Code content, diffs, repository names, and private repo identifiers are never sent. Your GitHub PAT and DeepSeek API key are stored in `localStorage` only and are sent exclusively to their respective services.

**Session replay:** PostHog session replay is enabled with strict text masking (`maskAllInputs: true`, `maskTextSelector: '*'`). All text — including any code visible in the UI — is masked in replays. Only interaction patterns and layout are recorded.

**Exception capture:** Unhandled JavaScript errors are forwarded to PostHog error tracking. Stack traces may include file paths but never code content or diff text.

**Drafts & privacy:** Comment drafts are stored entirely in your browser's IndexedDB — they never leave your device until you click "Submit review". At that point the draft bodies are sent directly to GitHub's API as part of the review submission payload; they are not sent to any other server, and they are not included in PostHog analytics events.

<!-- OAuth enabled: requires VITE_GITHUB_CLIENT_ID at build time -->
