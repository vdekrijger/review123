# review123 local bridge

A small, **optional** process you run inside a repo. While it runs,
[review123.dev](https://review123.dev) (or a local dev build) can talk to it
over `127.0.0.1` instead of going through the GitHub API and your own LLM API
keys.

It exists because the hosted app has two hard ceilings:

- **code + context** comes from the provider API — rate limited (roughly ten
  code searches a minute), capped at ~20k lines, and blind to anything that is
  not in the PR;
- **inference** is BYO-key, billed per token, even though many people already
  pay for Claude Code or Codex.

The bridge is the escape hatch for both. **Nothing in review123 requires it** —
with no bridge running the app behaves exactly as it does today.

> **Read this before you run it.** The bridge grants a web origin
> (`https://review123.dev`) **read access to the repo you start it in**, for as
> long as it runs, to anyone holding the pairing token it prints. That is the
> deal. The security model below is what keeps that deal narrow.

---

## Status

Protocol **v1**, complete. `GET /v1/health`, `POST /v1/infer`,
`POST /v1/infer/stream`, `POST /v1/files`, `POST /v1/search`,
`POST /v1/commits`, `POST /v1/fix`, `GET /v1/stack`, `POST /v1/checkout` and
`POST /v1/restore` are all implemented — nothing answers `501` any more.

- With `/v1/infer` live, review123 runs its reviews through the CLI you already
  pay for: pick **Local bridge** under Settings → AI models.
- With `/v1/infer/stream` live, those answers **type out** instead of appearing
  all at once after the wait, and cancelling one actually stops the CLI rather
  than leaving it running on your subscription. (`codex` has no partial-output
  mode, so its answers still arrive whole — the bridge says which, per call,
  rather than faking a typewriter.)
- With `/v1/files` and `/v1/search` live, it grounds those reviews in **your
  working tree** instead of the provider API — no rate limit, no 20k-line cap,
  and the whole repo rather than just the diff.
- With `/v1/fix` live (**`--allow-write` only**), a finding that has a concrete
  fix goes straight to your local coding agent, which fixes it in a **scratch
  worktree**, runs your tests, and hands back one commit per finding. You review
  the outcome — intent, diff, test result — and cherry-pick what you accept.
- With `/v1/checkout` live (**`--allow-checkout` only**), you can click through
  a pull request **in your own running app** instead of a deploy preview: the
  bridge checks it out in your existing checkout and the dev stack you already
  have running picks it up. Your database, your flags, your seed data. One
  click puts you back where you were.

> **The bridge is read-only unless you say otherwise, and there are TWO
> separate ways to say it.** `/v1/fix` exists only with `--allow-write`;
> `/v1/checkout` and `/v1/restore` only with `--allow-checkout`. **Neither flag
> implies the other** — the fix loop writes in an isolated scratch worktree and
> never touches your checkout, while checkout moves your branch, and consenting
> to one is not consenting to the other. Without the relevant flag the route
> answers `403` and its capability is `false`. A web page cannot turn either
> on, and there is no setting inside review123 that can.

> **Local grounding only happens when your checkout matches the PR.**
> `/v1/health` reports the tree's `head` sha, `branch` and whether it is
> `dirty`, and review123 uses local files **only** when `head` equals the PR's
> head sha. On a mismatch it falls back to the provider API and says so on
> screen. Grounding a review of PR #123 in `main`'s copy of a file would be
> silently wrong — worse than not having the bridge at all — so the bridge
> reports its state and the browser refuses to guess.

---

## Run it

Node 22 or newer, and nothing else — the package declares no dependencies.

### The prebuilt file (recommended)

Every release ships `bridge.mjs`, the whole bridge bundled into one
self-contained ESM file. Download it once, then run it inside whichever repo
you want to serve:

```sh
curl -fsSL https://github.com/vdekrijger/review123/releases/latest/download/bridge.mjs -o ~/review123-bridge.mjs
node ~/review123-bridge.mjs --root . --allow-write --allow-checkout
```

**Why the two flags are in the recommended line.** They are off in the code and
staying off — this is the *documented* command, not a default. `--allow-write`
turns on the fix loop ([§7](#7-writing-is-opt-in-at-the-command-line)) and
`--allow-checkout` turns on checking a PR out in your working tree
([§8](#8-checking-a-pull-request-out-is-a-second-separate-grant)); they are
independent and neither implies the other. The reason they live on the command
line is that **nothing review123 sends can switch them on** — so the grant
still holds if review123.dev is ever compromised and starts asking for things
you never agreed to. They protect you from *the website*, not from yourself.
Omitting them hardens nothing about the running process; it only means the two
features quietly do not work. Start it with `--root .` alone if you genuinely
want a read-only bridge.

`/releases/latest/download/` always resolves to the newest release, so that URL
does not need a version in it. The file's header comment records the version,
the commit it was built from, and the bundler version.

To check what you downloaded, rebuild it and diff: the bundle carries **no
build timestamp**, so a given commit always produces byte-identical output.
That is not a claim, it is measured — `bridge-v0.1.0` was built three times
(macOS/Node 26, an ubuntu-latest runner on Node 22, and a fresh shallow clone)
and all three produced sha256 `89bebe80…a4a2`.

### From a checkout

```sh
pnpm install                         # heavy: the whole SPA dev toolchain
pnpm bridge                          # = pnpm --filter @review123/bridge start
```

Honest warning: that `pnpm install` pulls review123's entire dev tree —
Playwright, vitest, svelte-check, Vite — purely so `tsc` can emit `dist/` for a
package with zero dependencies of its own. It is the right route if you are
changing the bridge, and the wrong one if you just want to run it.

Inside some **other** repo, after building the package once
(`pnpm --filter @review123/bridge build`):

```sh
node /path/to/review123/bridge/dist/cli.js --root .
```

The package intentionally has no root workspace dependency, so there is no
`node_modules/.bin/review123-bridge` shim: linking a bin whose `dist/` may not
be built yet is a way to break `pnpm install` on a fresh checkout (and on the
Vercel deploy), which is a bad trade for a shorter command.

### Either way

It prints a banner with the pairing token:

```
review123 bridge 0.5.0  ·  protocol v1

  repo     /Users/you/code/your-repo
  listen   http://127.0.0.1:7321   (loopback only)
  CLIs     claude, codex
  origins  https://review123.dev  https://www.review123.dev  http://localhost:*  http://127.0.0.1:*
  writes   ENABLED (--allow-write)
  checkout ENABLED (--allow-checkout) — this bridge may switch your branch
  push     disabled — nothing ever leaves this machine

  Paste this pairing token into review123 → Settings → Local bridge:

    Kx9f...43 characters...

  This token is new for this run. Restarting the bridge invalidates it.
```

Paste that token into **review123 → Settings → Local bridge**. Stop the bridge
with Ctrl-C; the token dies with the process.

### Flags

| Flag | Default | What it does |
| --- | --- | --- |
| `--port <n>` | `7321` | Port to bind on `127.0.0.1`. |
| `--root <dir>` | cwd | The repo to serve. Resolved once, through `realpath`. |
| `--token-file <path>` | — | Reuse/store the pairing token instead of minting a fresh one per run. Created `0600`. |
| `--allow-origin <o>` | — | An extra **exact** origin allowed to call the bridge. Repeatable, additive to the defaults. |
| `--allow-write` | **off** | Enables `POST /v1/fix`: review123 may hand findings to your local coding agent, which fixes them **in a scratch git worktree** and hands back one commit per finding. Your checkout, branch, index and uncommitted work are never touched, and nothing is pushed. Without it the route answers `403` and `capabilities.fix` is `false`. See [§7](#7-writing-is-opt-in-at-the-command-line). |
| `--test-command <cmd>` | detected | What `/v1/fix` runs to check its own work, e.g. `"pnpm test"`. Split on spaces and run **without a shell** — shell syntax is refused, not silently half-run. |
| `--no-tests` | — | Never run a test command during `/v1/fix`. |
| `--allow-checkout` | **off** | Enables `POST /v1/checkout` and `POST /v1/restore`: review123 may check a pull request out **in this working tree**, so the dev server you already have running serves it. **Separate from `--allow-write`, which does not enable it.** A dirty tree is refused outright; moving uncommitted work needs a second explicit confirmation and uses `git stash push`. See [§8](#8-checking-a-pull-request-out-is-a-second-separate-grant). |
| `--allow-push` | **off** | Enables `POST /v1/push`: review123 may move **one existing remote branch forward to one commit**, after you confirm the exact move. **The only thing this tool does that leaves your machine, and it cannot be undone.** Separate from both flags above; neither enables it. Fast-forward only — a push that would drop commits is refused, and there is no force anywhere in the protocol. Never the remote's default branch, and never a branch that does not already exist. Without it the route answers `403` and `capabilities.push` is `false`. See [§9](#9-pushing-is-a-third-grant-and-the-only-one-that-leaves-your-machine). |
| `--app-url <url>` | detected | Where your dev server listens, e.g. `http://localhost:8010`. Must be a **loopback** address — the bridge opens a socket to it. |
| `-h`, `--help` | — | Usage. |

There is deliberately **no flag to change the bind address**, and **no request
field, header or browser setting that can enable writing** — `--allow-write` is
typed by the person at the terminal or it does not happen. The same is true of
`--allow-checkout` and of `--allow-push`, and all three are **independent in
every direction**: none implies another. In particular, a bridge started with
`--allow-write --allow-checkout` still reports `capabilities.push: false` and
still answers `403 push-disabled`.

---

## Security model

A local server that can read files and run CLIs, reachable from a web page, is a
serious attack surface. Eight rules keep it narrow. Each one has tests in
`src/*.test.ts`.

### 1. Loopback only

`listen({ host: '127.0.0.1' })` — never `0.0.0.0`, never the default (which
binds every interface). On a laptop on a café network that difference is whether
the room can read your repo. `server.test.ts` starts a real server and asserts
the bound address.

### 2. Pairing token on every request

On startup the bridge generates a **32-byte** random token
(`crypto.randomBytes`, base64url — 43 characters) and prints it. Every request
must carry `Authorization: Bearer <token>`; anything else is a `401` **before
any work happens**. Comparison is constant-time (`crypto.timingSafeEqual`), with
a length check first so a mismatch cannot throw.

The token is **per process** — restarting the bridge invalidates it, so a token
that leaked into a screenshot or a shell history stops working. `--token-file`
opts into a stable token (stored `0600`) for people who restart often.

### 3. Exact-match CORS allowlist, never `*`

Allowed origins:

- `https://review123.dev` and `https://www.review123.dev` — two exact strings,
  because the apex answers `308 → www` and `www` is therefore the origin every
  real browser actually sends. Listing only the apex is what made the bridge
  unreachable before 0.2.0: a genuine user's preflight got the bare `403`
  below, which the page cannot tell apart from "no bridge is running";
- `http://localhost[:port]` and `http://127.0.0.1[:port]` — scheme and host
  pinned exactly, port wildcarded because dev servers pick what is free;
- anything passed with `--allow-origin`, compared as an exact string.

Everything else — `https://review123.dev.evil.test`, `https://api.review123.dev`,
`http://localhost.evil.test`, `null`, `*` — gets a `403` **with no
`Access-Control-Allow-*` headers at all**, so a browser cannot read the response
even if it wanted to. Allowed origins are echoed verbatim (never `*`) with
`Vary: Origin`. `Access-Control-Allow-Credentials` is deliberately absent: the
bridge is bearer-token-only and must never be reachable with ambient cookies.

Preflight (`OPTIONS`) is answered `204` with the CORS headers and **without**
requiring the token, because browsers do not send `Authorization` on a
preflight. A preflight from a disallowed origin is still a bare `403`.

A preflight carrying `Access-Control-Request-Private-Network: true` is answered
`Access-Control-Allow-Private-Network: true` — **only** when the origin already
passed the allowlist. That header widens nothing by itself: it is the server
saying "yes, I meant to be reachable from a web page", which this bridge did
mean or it would not exist. The origin allowlist, the pairing token, the Host
anti-rebinding guard and loopback binding all still run on the request that
follows, and that layering is exactly why answering it is safe. A rejected
origin still gets a bare `403` with no `Access-Control-*` header of any kind.

### 3a. Your browser is a gate too — Local Network Access

**A website reaching a server on your own machine needs YOUR permission, and no
setting on this side can grant it.** Chrome 142+ ships Local Network Access,
which replaced the older Private Network Access preflight: a page on a public
origin (`https://www.review123.dev`) may not open a connection to
`http://127.0.0.1` until you allow it.

What actually happens, measured against Chromium 148 and Chrome 154:

- Chrome sends **no** preflight and **no**
  `Access-Control-Request-Private-Network` header. Nothing reaches this
  process — not one byte.
- The page's `fetch` rejects in about a millisecond with a bare
  `TypeError: Failed to fetch`, which is the *same* error a refused connection
  gives. **Search for this console line** when it happens again:

  ```
  Access to fetch at 'http://127.0.0.1:7321/v1/health' from origin
  'https://www.review123.dev' has been blocked by CORS policy: Permission was
  denied for this request to access the `loopback` address space.
  ```
- `navigator.permissions.query({ name: 'local-network-access' })` answers
  `prompt`, `granted` or `denied`. review123 asks it on a failed pairing so it
  can tell you the browser blocked the request instead of telling you to start
  a bridge that is already running.

**The fix is one click:** when Chrome asks to *"look for and connect to any
device on your local network"*, choose **Allow**. If you never saw the prompt
(or said no), open the icon to the left of the address bar → **Site settings**
→ **Local network access** → **Allow**, then press Connect again.

Firefox and Safari do not gate local network requests this way today.

### 4. Repo confinement (`..`, absolute paths, symlinks)

The bridge is started inside one repo and resolves that root **once**, through
`realpath`. Every requested path is then:

1. refused if it is absolute or contains a NUL byte;
2. resolved against the real root — which neutralises `..`, and is re-checked
   for containment;
3. put through `realpath` itself, and re-checked.

Step 3 is the one that matters. `repo/link -> /etc` passes a `path.resolve`
containment check perfectly; only following the symlink catches it.
`confine.test.ts` builds a real temp tree with `escape-dir -> ../outside` and
`escape-file -> ../outside/secrets.env` and asserts both are refused, alongside
`..` traversal, absolute paths and Windows-style absolute forms. An escape is a
`403 forbidden-path`.

### 5. No arbitrary command execution

The protocol **never accepts a command**. `InferRequest` names a CLI by id from
a hard-coded set (`claude`, `codex`); it carries no argv, shell string, cwd or
environment. The bridge builds the invocation itself, in `infer.ts`, from a
fixed shape:

- `spawn(bin, argvArray)` — **never** `exec`, **never** `shell: true`. With an
  argv array nothing is word-split, so no prompt content can become a flag or a
  command separator.
- The **prompt goes on stdin**, never in argv. `argv` is world-readable in `ps`
  (which would hand every process on the machine the user's code) and is capped
  at `ARG_MAX` — a packed review context would simply fail to exec.
- The **system prompt** avoids argv too: `claude` reads it from a `0600` temp
  file via `--system-prompt-file`; `codex exec` has no such flag, so it is
  framed into the stdin payload.
- Every path in `files` goes through the same confinement check as everything
  else (rule 4), so `..`, absolute paths and escaping symlinks are a `403`.

Even capability detection refuses to run anything: `capabilities.inference` is
produced by **stat-ing PATH entries for an executable file**, not by spawning
`which` and not by making a model call. Probing a CLI by running it would burn
the user's subscription quota just to render a settings page.

Two other places spawn a process, and both stay inside the same promise:

- **`git`, for `/v1/health`'s repo state** (`gitState.ts`). Three invocations,
  every argv a hard-coded literal, every one **read-only**: `rev-parse --verify
  HEAD`, `rev-parse --abbrev-ref HEAD`, `status --porcelain`. No request field
  is ever appended — `readGitState` takes no request input at all — and there
  is deliberately no code path in the file that can check out, fetch, reset or
  stash. It runs with `GIT_OPTIONAL_LOCKS=0`, so a health probe cannot take the
  index lock out from under a command you are running yourself.
- **`rg`, for `/v1/search`** (`search.ts`). Again `spawn` with an argv array and
  no shell. The query is carried by `-e`, so a search for `--version` is a
  *pattern*, never a flag; `--` then ends option parsing before the search path.
  `--no-follow` means a symlink out of the repo cannot smuggle outside content
  into a result. If `rg` is absent (or fails), a bounded JS walk answers
  instead, so the route never depends on it.

### 5a. It INVOKES your CLI — it never borrows its credentials

The bridge runs `claude` / `codex` as a subprocess and lets each authenticate
itself, exactly as it does when you run it in a terminal. It does **not** read,
copy or reuse the CLI's stored OAuth credentials to call a vendor API directly.

That would take auth a subscription issues for its own client and spend it
somewhere else — which is circumventing the subscription, not using it. There
is deliberately **no code path in this package that opens a credentials file**,
and `--bare` (which would force `ANTHROPIC_API_KEY` and never read the
subscription at all) is explicitly *not* used.

One honest consequence: **the bridge cannot tell you whether your CLI is signed
in** without running it. `/v1/health` therefore reports no authentication
state; Settings → AI models → *Test* does a real one-turn round-trip instead.

### 6. Caps

| Cap | Value |
| --- | --- |
| Request body | 1 MiB (`413` — enforced **while streaming**, never buffered first) |
| Request RECEIVE timeout | 30 s (`server.requestTimeout`) |
| Headers timeout | 10 s (slow-loris budget) |
| `/v1/infer` per-call budget | 120 s default, 600 s ceiling |
| `/v1/infer` stdout buffered | 4 MiB, then the child is killed and `truncated: true` |
| `/v1/infer` `files` content inlined per call | 256 KiB total |
| `/v1/files` paths per request | 200 (over the cap is a `400`, never a silent trim) |
| `/v1/files` bytes per file | 2 MiB (`maxBytes` clamps below it) |
| `/v1/files` bytes per response | 4 MiB across all files |
| `/v1/search` results | 200 default, 1000 ceiling |
| `/v1/search` wall clock | 15 s, then whatever was found comes back `truncated: true` |
| `/v1/search` file size | files over 1 MiB are not searched |
| `/v1/search` files scanned (JS fallback) | 20 000 |
| `git` probes behind `/v1/health` | 5 s, then the state is reported as `null` |
| `/v1/fix` findings per request | 10 (over the cap is a `400`, never a silent trim) |
| `/v1/fix` rounds per finding | 3 (a request may lower it, never raise it) |
| `/v1/fix` per-finding CLI budget | 300 s default, 600 s ceiling |
| `/v1/fix` total wall clock | 30 min, then the finished commits come back with `stopReason: "budget-exhausted"` |
| `/v1/fix` patch per change | 256 KiB, then `truncated: true` |
| `/v1/fix` test run | 10 min, 64 KiB of output buffered |

`server.requestTimeout` bounds how long a client may take to **send** a request,
not how long the bridge may take to answer — which is why a multi-minute CLI
turn is legal under a 30 s receive budget. The inference budget is separate,
enforced by killing the child (`SIGTERM`, then `SIGKILL` after 2 s).

### 7. Writing is opt-in at the command line

Everything above describes a **read-only** bridge, and that is what you get
unless you start it with `--allow-write`. This section is about the one route
that writes.

**`--allow-write` is the entire authorisation model.** It is a process flag,
read once from `argv` at startup. There is no request field, no header, no
`localStorage` setting and no browser affordance that can enable it; the
handler checks it *before parsing the body*, so a read-only bridge never
reaches a line of the fix machinery. `/v1/health` reports it as
`capabilities.fix`, which is why that flag is the one capability that is not a
release-readiness boolean. It dies with Ctrl-C.

**Your working tree is never touched.** All work happens in a **scratch git
worktree** created from the PR's head commit with `git worktree add`, in a
directory under your OS temp dir keyed by repo + head sha. It has its own HEAD
and its own index and shares only the object store, so your branch, your index
and every uncommitted line you have not pushed stay exactly as they were.
`fix.test.ts` dirties a real checkout, runs a whole fix loop, and asserts the
tree is byte-for-byte identical afterwards.

*(The scratch worktree is under the temp dir and **not** inside `.git/`,
because a coding agent treats anything under `.git/` as git's own
configuration territory and refuses to edit it — verified against
`claude` 2.1.278, which answered "sensitive-file approval unavailable".)*

**What it does write**, stated plainly:

1. a directory under your OS temp dir (removed and rebuilt per run, and older
   slots are retired — only ever paths inside that one parent directory);
2. git worktree admin data in `$GIT_DIR/worktrees/…` — unavoidable, and part of
   no working tree;
3. **one branch ref**, always under `review123/fix/`. That is what makes the
   returned commits cherry-pickable from your own checkout. Nothing outside
   that prefix is created, moved or deleted.

**Nothing is pushed.** There is no remote-touching git command anywhere in the
package. The route *returns* commits; applying them is your move, from your own
terminal, with the shas it gives you.

**The agent gets file tools and nothing else.** `claude` is started with
`--tools Read,Edit,Write,Grep,Glob` — no `Bash`, no `WebFetch` — plus
`--restricted` (file tools confined to the working directory; your settings
files ignored), `--safe-mode` (no CLAUDE.md, hooks, plugins, MCP) and
`--permission-prompts none`. It cannot run a command, so it cannot commit,
stash, or reach a network, whatever a finding tells it. `codex` gets
`--sandbox workspace-write`, its equivalent. **The bridge makes every commit
itself**, which is also what guarantees one commit per finding.

**Findings are data, not instructions.** A finding is text a language model
wrote while reading a diff. The system prompt frames it as a *claim to
evaluate*, names the categories that must be refused (removing an auth check,
disabling a test, widening access), and makes refusing cheap: the agent replies
`SKIP: <reason>` and the whole attempt is discarded. A refusal comes back as a
first-class result (`skipped[].reason === "refused"`), not a failure.

**The test command is the biggest thing the flag grants, and it is yours.**
`/v1/fix` runs your repo's own test script — detected from the scratch
worktree's `package.json` and the lockfile beside it, or set with
`--test-command`, or disabled with `--no-tests`. That script comes from the PR
head, i.e. code under review, which is precisely why enabling any of this
requires a flag you type. The command is **never** a request field; a command
supplied by a web origin would be arbitrary command execution however politely
it were spelled.

**One honest caveat.** A scratch worktree has no `node_modules`, so tests could
not run at all. The bridge therefore creates a single symlink,
`node_modules` → your checkout's `node_modules`, and excludes it from every
commit. Consequence, stated rather than buried: a test that *writes* into
`node_modules` would write into your checkout's copy. Nothing else in your
checkout is reachable from the scratch tree. The alternative — never running
tests in a JS repo — would make "the agent ran the tests" a lie.

### 8. Checking a pull request out is a second, separate grant

Everything in §7 turns on `--allow-write`, and every word of its promise —
*your checkout, branch, index and uncommitted work are never touched* — is
still true. That promise belongs to **the fix loop**, and the fix loop still
keeps it.

`--allow-checkout` is a **different grant for a different thing**. It lets
review123 check a pull request out **in your working tree**, so the dev stack
you already have running serves it: Vite hot-reloads, Django autoreloads, and
the app on `localhost` is the pull request seconds later. No second stack, no
second database.

**The two flags never stand in for each other.** `--allow-write` does not
enable checkout, `--allow-checkout` does not enable the fix loop, and the
refusal message says so — because someone who enabled agent fixes must not
discover they also handed a web page their branch.

What it may do, and what it will never do:

| | |
| --- | --- |
| **Refuses a dirty tree** | Outright, with the list of files, before fetching anything. Nothing is ever checked out over your work. |
| **Moves work only on a second confirmation** | `git stash push --include-untracked`, and only when the request explicitly says `stashDirty`. The entry's **sha** is recorded — not `stash@{0}`, which shifts. |
| **Restores with `apply`, never `pop`** | `pop` drops the entry on success, and dropping is destroying. `apply` leaves it in the list, so a failed restore costs nothing. The drop command is handed to **you**. |
| **Never forces anything** | No `--force`, no `reset --hard`, no `clean`, no `stash drop`, no `checkout -f`, no `-B`. When git refuses, that refusal is reported verbatim — it is git protecting your work. |
| **Always records the way home** | The branch you were on (or the sha, if you were detached) is written to `~/.review123-bridge/checkouts/<hash>.json` **before anything moves**, so a bridge restart cannot strand you. |
| **Lands detached** | At the fetched commit, creating no ref — so there is nothing left behind to clean up and nothing that can collide with a branch you have. |
| **Requires you to acknowledge what a checkout IS** | Checking a ref out and letting a dev server autoreload it **runs that code**, install scripts and all. The bridge cannot tell a fork's ref from the repo's own, so it refuses every checkout unless the request explicitly acknowledges that. The browser asks first, and names the risk. |

Three irregular cases each get their own refusal with an explicit answer,
rather than a guess: the tree is dirty now (`tree-dirty` → `stashDirty`), the
branch you came from was deleted (`prior-gone` → `detachToSha`), or HEAD moved
since (`moved-since` → `acknowledgeMoved`).

`checkout.ts` holds all of this, and `checkout.test.ts` proves it against
**real git repositories** with real uncommitted content — including one test
that collects every argv the module issues across every path and asserts the
destructive vocabulary never appears in any of them.

#### Finding your dev server

`GET /v1/stack` reports whether your app is up. The browser cannot find this
out itself — a page on `https://review123.dev` that fetches `localhost:8010`
gets an identical CORS failure whether the port is serving a thriving app or
nothing at all, which is exactly the port-scanning attack the same-origin
policy exists to prevent. The bridge just opens a socket.

The ladder, each rung reported as its own `source`:

1. `--app-url` — you said so.
2. **PostHog** — detected from marker files (`package.json` named `posthog`,
   or `manage.py` beside `posthog/settings/base.py`), never from the directory
   name. Its dev stack is fronted at the fixed port `8010`.
3. **`package.json`** — a `dev` or `start` script that *names* a port
   (`--port N`, `--port=N`, `-p N`, `PORT=N`).
4. **`unknown`** — and that is what it says.

The fourth rung is the feature, not a gap. Assuming Vite's 5173 when a `dev`
script names no port would frame whatever else happens to be on 5173 and
present it as your pull request. A wrong answer delivered confidently is worse
than "I could not tell", so it says the latter and `--app-url` is right there.

`--app-url` is restricted to a **loopback** origin at parse time: the bridge
connects to it, and a flag that accepted any host would turn a local
convenience into a probe for whatever else the machine can reach.

### Bonus: DNS-rebinding guard

`127.0.0.1` can be reached from `http://evil.test/` if an attacker rebinds that
name's DNS to loopback — and such a request is *same-origin* to the browser, so
the `Origin` check would not fire. The `Host` header still says `evil.test`, so
the bridge requires a loopback `Host` (`127.0.0.1`, `localhost`, `[::1]`,
optionally with the port it bound) and answers `403 forbidden-host` otherwise.

### 9. Pushing is a third grant, and the only one that leaves your machine

Everything in §7 and §8 is **reversible by the person who granted it**. A
scratch worktree can be deleted. A checkout can be restored — that section's
whole promise is that you can always get back.

A push has no such promise available, and pretending otherwise would be the
one dishonest sentence in this document. The instant it lands, everyone with
read access to the repository can see it, CI may start on it, and a colleague
may pull it. Nothing this bridge offers takes it back.

So `--allow-push` is a **third flag**, off by default, implied by neither of
the others and implying neither. Someone who wanted agent fixes, or wanted a
pull request running under their dev server, must not discover that they also
handed a web origin the ability to write to their team's remote.

#### What it enforces

The design question is not "how do we make pushing convenient". It is "what
can this process actually *guarantee*, mechanically, without trusting the
caller". That list is short, and the route enforces exactly it:

| | |
| --- | --- |
| **Fast-forward only** | The commit must be a descendant of the remote branch's **current** tip, proven locally with `git merge-base --is-ancestor` before anything is sent. A fast-forward only ever *adds* commits, so no reachable commit can stop being reachable. This is a property of the graph, not of anyone's good intentions. |
| **No force, ever** | Not "force defaults to off" — there is no request field, no argument and no code path that can produce `--force`, `--force-with-lease` or a `+` refspec. The protocol cannot express it, and `push.test.ts` greps the module to keep that true. |
| **Never the default branch** | The remote's own default is read from the remote (`git ls-remote --symref … HEAD`) and refused by name, alongside a list of names the bridge refuses on sight (`main`, `master`, `trunk`, `develop`, `production`, …). If the default cannot be established, the push is **refused rather than guessed**. |
| **The branch must already exist** | Creating a branch is a different act with different consequences. Folding it in would let one confirmation stand for two decisions. |
| **One push per explicit request** | The request names the remote, the branch, the sha it believes the branch is at (`expectedRemoteSha`) and the sha it wants it to be at. All four come back in the response. No batching, and **no retry** — a push that failed is reported, never re-attempted, because "it probably did not land" is not something this route will assume. |
| **A clean working tree** | Refused if your checkout has uncommitted changes. Not because a dirty tree could corrupt a push — it cannot, a push sends committed objects — but because you are confirming a move while looking at a checkout whose contents are not what would go out, and this is the one operation where "I thought that was included" cannot be taken back. |

Every gate from §§1–6 still applies unchanged: loopback bind, pairing token on
every request, exact-origin CORS, the `Host` anti-rebinding check, and realpath
repo confinement.

#### The guarantee it deliberately does NOT make

The natural thing to want is *"only branches of pull requests I authored"*.
**The bridge cannot do that, and does not pretend to.** It has no GitHub
account, holds no token, and the branch name arrives from the caller. A check
like that would read as a guarantee while resting entirely on the honesty of
the thing it claims to guard against — which is worse than no check at all,
because people would rely on it.

Fast-forward-only is the property that holds no matter who asks. It is a
weaker-sounding promise and a much stronger one.

#### Every refusal keeps its own sentence

`protected-branch`, `default-branch-unknown`, `remote-unknown`,
`branch-missing`, `commit-unknown`, `tree-dirty`, `remote-moved`,
`not-fast-forward`, `nothing-to-push`, `remote-unreachable`, `push-rejected`,
`push-failed` — twelve codes, twelve sentences. Half of them are answered by a
*different* action (fetch, commit your work, look again, ask an admin), and a
user told only that "the push failed" will either give up or retry blindly.
Blind retry is the wrong instinct for the one operation that can already have
half happened.

---

### 10. Fixing a failing CI run, and the round-zero gate

`POST /v1/ci-fix` runs on `--allow-write` — **not** `--allow-push`. It works
in the same scratch worktree the fix loop uses, reuses the same loop, and
commits there. Pushing what it made is a separate request with a separate
grant and a separate confirmation.

The interesting part is what happens *before* the agent starts.

**CI failures do not always reproduce locally.** A different operating system,
a service that only exists in the runner, a secret this machine has never
seen, a test that fails one run in forty. Hand an agent "CI is red" plus a log
it cannot reproduce and it will not say "I do not know" — it will produce a
confident, plausible, entirely unverifiable diff. That is bad anywhere, and
much worse here, because this flow is designed to end in a push.

So before any agent runs, the bridge runs **your own test command**, in the
scratch worktree, at the pull request's head, unchanged:

| Baseline | Verdict | What happens |
| --- | --- | --- |
| **failed** | `reproduced` | There is a real local signal to work against and to re-check against. The fix loop runs exactly as it does for a review finding. |
| **passed** | `not-reproduced` | **No agent is started.** No prompt, no edit, no commit — so there is nothing that *could* be pushed. You are told the truth and pointed at `--test-command`, because the usual cause is CI failing in a step (a build, a type-check, an end-to-end suite) your `test` script does not cover. |
| anything else | `no-local-signal` | Same outcome, same reason: with no way to watch the failure stop, nothing here has earned the word *fix*. |

This lives in the bridge rather than in the browser because **a check on the
client is a check a client can skip**. This one cannot be, since the code that
would create the commits is on the far side of it.

The agent's prompt differs from the fix loop's in two ways that matter. A CI
log is framed as **data** — it is written by tools, and an agent that read a
log as instructions could be steered by anyone who can make CI print a line.
And the ways of cheating are named and forbidden: deleting or skipping a test,
weakening an assertion, swallowing an error, widening a timeout, marking
something flaky. Every one of those produces a green run and a worse
repository. Giving up honestly is offered as the better answer, because it is.

**What a green local run still does not prove.** It is one command, on one
machine, in one environment. Pushing makes CI run again, and what CI then
reports is a *new result*, not a verdict. Nothing in this package's responses
says otherwise, and the commit message the CI flow writes says so in the
repository's permanent history.

---

### What the bridge does NOT do

- **Without `--allow-write`** it does not write to your repo at all, and the
  CLIs it runs cannot either: `claude` is started with no tools whatsoever,
  `codex` with a read-only sandbox.
- **With `--allow-write`** it still never touches your working tree, your
  branch, your index or your uncommitted work, and **nothing leaves your
  machine** — pushing needs its own flag. See
  [§7](#7-writing-is-opt-in-at-the-command-line) for exactly what it does
  write.
- **Without `--allow-push`** nothing this bridge does ever reaches a remote,
  whatever the other two flags are set to.
- **With `--allow-push`** it may move one existing remote branch **forward**,
  once per explicit request — and it can only ever do that: no force, no
  branch creation, never the default branch, and a non-fast-forward is refused
  rather than routed around. See
  [§9](#9-pushing-is-a-third-grant-and-the-only-one-that-leaves-your-machine).
- **With `--allow-checkout`** it may move your working tree — that is the
  point of the flag — but it never destroys anything doing so: a dirty tree is
  refused, work moves only via `git stash push` on a second explicit
  confirmation, restores use `apply` and never `pop`, and there is no
  `--force`, `reset --hard`, `clean` or `stash drop` anywhere in the code
  path. See [§8](#8-checking-a-pull-request-out-is-a-second-separate-grant).
- **Without `--allow-checkout`** your working tree is never modified at all,
  whatever `--allow-write` is set to.
- It does not read anything outside the repo root.
- It does not phone home, log request bodies, or persist anything except an
  explicit `--token-file`. The temp files an inference call needs (the system
  prompt, codex's last-message file) are `0600`, in a `0700` directory, and are
  deleted when the call ends.
- It never sends the repo's absolute path to the browser — `/v1/health`
  reports the directory **basename** only, and a CLI's stderr is stripped of
  every absolute path before any of it is quoted in an error message.
- It never reads your CLI's stored credentials. See §5a.

---

## Protocol v1

JSON over HTTP on `127.0.0.1`. The version lives in the **path**, so an old
browser build and a new bridge can never half-understand each other — a
mismatched client simply 404s.

One route answers incrementally rather than with a single document:
[`POST /v1/infer/stream`](#post-v1inferstream--implemented), framed as NDJSON.
Everything below about gates, codes and caps applies to it unchanged.

Every non-2xx response is:

```jsonc
{ "ok": false, "error": "<code>", "message": "<human sentence>" }
```

with `error` one of `bad-request`, `unauthorized`, `forbidden-origin`,
`forbidden-host`, `forbidden-path`, `not-found`, `method-not-allowed`,
`not-implemented`, `payload-too-large`, `timeout`, `cli-unavailable`,
`cli-failed`, `write-disabled`, `worktree-failed`, `head-unknown`,
`checkout-disabled`, `tree-dirty`, `ref-unknown`, `checkout-failed`,
`no-prior-state`, `prior-gone`, `moved-since`, `untrusted-unacknowledged`.

A `tree-dirty` body carries two extra fields, `dirtyPaths` and `dirtyCount`,
so a client can name exactly what a stash would move instead of asking the
user to take "your tree is dirty" on trust.

Codes are **additive within v1**: a client that meets one it does not recognise
must fall back on `message`, never crash.

### `GET /v1/health` — implemented

```jsonc
{
  "ok": true,
  "protocol": 1,
  "root": "your-repo",          // BASENAME only, never the absolute path
  "capabilities": {
    "inference": ["claude"],    // CLIs DETECTED on PATH — see below
    "infer": true,              // route READINESS — one flag per route
    "inferStream": true,        // ditto, for POST /v1/infer/stream
    "inferAgentic": true,       // ditto, for InferRequest.agentic (read-only tools)
    "files": true,
    "search": true,             // true even without ripgrep: a JS walk answers
    "fix": false,               // the --allow-write FLAG, not a readiness bit
    "checkout": false           // the --allow-checkout FLAG — a SEPARATE grant
  },
  "git": {                      // the working tree RIGHT NOW — or null
    "head": "9f1c…",            // full 40-char sha
    "branch": "feat/thing",     // null on a detached HEAD
    "dirty": false              // any `git status --porcelain` output at all
  },
  "version": "0.1.0"
}
```

**`capabilities` has three different kinds of entry, on purpose:**

- `inference` is a **detection** signal: which of the known CLIs exist on
  `PATH`. It says nothing about whether the route works.
- `infer`, `inferStream`, `inferAgentic`, `files` and `search` are
  **route-readiness** booleans, one per route (or request capability) and named
  after it. Each flips *in the same commit that implements it*, so a client that
  trusts the flag can never call a route that is not there. All five are `true`
  — v1 is complete.

  `inferAgentic` is the one where reading the flag wrong is *silent*. It is not
  a permission flag — nothing grants it, because what it enables is reading —
  but an older bridge does not refuse an `agentic` request, it ignores the field
  and returns an ordinary single-pass answer. A client that skipped this check
  would label that answer a deep, locally-grounded review. Check it *before*
  offering deep review, exactly as `files`/`search` are checked before claiming
  local grounding.
- `fix` and `checkout` are **authorisation** signals: each reports whether
  *this process* was started with its own flag (`--allow-write`,
  `--allow-checkout`). Neither is "true from the release that shipped the
  route", because the route existing and the route being permitted are
  different facts, and a client must show the user the second one. Without the
  flag, `/v1/fix` answers `403 write-disabled` and `/v1/checkout` answers
  `403 checkout-disabled`.

**`fix` and `checkout` are independent in both directions.** `fix` grants
writing inside an isolated scratch worktree; `checkout` grants moving *your
own* working tree. A client must never read one from the other, and the bridge
never does either — see [§8](#8-checking-a-pull-request-out-is-a-second-separate-grant).

`search` is `true` whether or not `ripgrep` is installed. The flag reports
whether the **route** exists, never how fast it will be; conflating the two
would make a client refuse a search that works perfectly well.

`infer` is `true` **even when `inference` is empty**, and that is not a bug: the
two answer different questions. `infer` says "this bridge understands the
route"; `inference` says "and here is what it could run". A client needs both —
and asking for a CLI that is not installed gets a precise `cli-unavailable`
rather than a confusing `501`.

**`git` is the field local grounding turns on.** It is the working tree's state
*right now*, from three read-only `git` commands (§5). `null` means the root is
not a repository, has no commits yet, or `git` did not answer — and a client
must read `null` as **"no match is provable"**, never as permission to guess.

review123 uses `/v1/files` and `/v1/search` for a review **only when `head`
equals that PR's head sha**. On any mismatch it falls back to the provider API
and names both shas on screen. A `dirty` tree is still used when the head
matches — you may well be mid-work, and that is a legitimate thing to review —
but the UI flags it once, because a finding grounded in uncommitted code is a
real possibility the reviewer should know about.

**Authentication state is deliberately not reported.** The only cheap signals
("a credentials file exists", "an API-key env var is set") lie routinely —
expired sessions, keys for another account, credential helpers that keep nothing
on disk. The protocol would rather say nothing than guess, and reading a
credentials file is exactly what §5a forbids. A real answer costs a CLI
invocation: that is what Settings → AI models → *Test* does.

### `POST /v1/infer` — implemented

Run a prompt through one of the user's local CLIs, on their subscription.

```ts
interface InferRequest {
  cli: 'claude' | 'codex'   // an ID from a hard-coded set — NEVER a command
  prompt: string            // delivered on STDIN, never in argv
  model?: string            // --model <id>; omitted → the CLI's own default
  system?: string
  files?: string[]          // repo-relative, confined to the root; inlined
  maxOutputTokens?: number  // accepted, but see "ignored" below
  timeoutMs?: number        // clamped to [1, 600_000]; default 120_000
}

interface InferResponse {
  ok: true
  cli: string
  text: string              // the CLI's final assistant text, never its log
  truncated: boolean
  durationMs: number
  usage?: { inputTokens: number; outputTokens: number }   // when reported
}
```

Failures: `400 bad-request`, `403 forbidden-path`, `503 cli-unavailable`,
`504 timeout`, `502 cli-failed`.

#### Verified invocations

Checked against **claude 2.1.278** and **codex-cli 0.155.1** by running
`--help` and a real one-turn call:

```sh
claude -p --output-format json --tools "" --permission-prompts none \
       --safe-mode --system-prompt-file <tmp>          # prompt on stdin

codex exec --sandbox read-only --skip-git-repo-check --color never \
       --ephemeral --output-last-message <tmp> -       # prompt on stdin
```

Why each flag is there:

| Flag | Why |
| --- | --- |
| `--tools ""` | Disables **every** built-in tool. The bridge promises it does not write to your repo; a tool-less `claude` physically cannot. It also makes the call a plain completion, which is all review123 wants. |
| `--permission-prompts none` | Anything that would prompt is denied, instead of blocking forever on a terminal nobody is watching. |
| `--safe-mode` | Drops `CLAUDE.md`, hooks, plugins, MCP servers and custom agents, so your own repo instructions do not silently contaminate review123's prompts. Auth is explicitly unaffected. |
| `--system-prompt-file` | Keeps a large system prompt out of `ps` and out of `ARG_MAX`. Always passed: inheriting the CLI's default prompt would prepend thousands of tokens describing a toolbelt this process does not have. (Measured: replacing it cut one trivial call from 3 704 to 445 input tokens.) |
| `--sandbox read-only` (codex) | Codex has no way to disable its tools, so it is confined to reading instead. |
| `--output-last-message` (codex) | `codex exec` prints a human transcript on stdout; the final assistant message lands in this file, alone and clean. That is why the bridge does not parse its event log. |
| `--ephemeral` (codex) | Keeps review123's prompts out of your session history. |
| `--model <id>` | **Only when the request names one.** Without it the argv is byte-identical to what it was before the flag existed, so the CLI answers with whatever model you configured it with. |

**`--bare` is deliberately NOT used**: it forces `ANTHROPIC_API_KEY` and never
reads the subscription, which would defeat the entire point of the bridge.

#### Verified agentic invocations (deep review)

`InferRequest.agentic` runs the CLI **with** its own read-only tools, so a
reviewer can open the real file before making a claim. Verified against the
same two CLI versions, by running them:

```sh
claude -p --output-format json --tools "Read,Glob,Grep" --restricted \
       --strict-mcp-config --permission-prompts none --safe-mode \
       --system-prompt-file <tmp>                      # prompt on stdin

codex exec --json --sandbox read-only --skip-git-repo-check --color never \
       --ephemeral --output-last-message <tmp> -       # prompt on stdin
```

**Why the old rationale was wrong.** The settings copy used to say deep review
was impossible over the bridge because "the CLI is already an agent". The CLI
is not acting as an agent in the ordinary invocation — `--tools ""` above is
*us* taking its tools away. Giving three read-only ones back is the feature,
and the result is **better** grounded than the API path: the CLI reads your
actual working tree, uncommitted changes included, instead of fetching files
through a rate-limited VCS API.

| Flag | Why |
| --- | --- |
| `--tools "Read,Glob,Grep"` | A reviewer needs to open a file, find a file, and find a symbol. Everything else either writes (`Write`/`Edit`), executes (`Bash`) or leaves the machine (`WebFetch`) — none of which a review needs. **Verified:** asking the CLI to enumerate its tools under this exact argv answers `Glob, Grep, Read` and nothing else. |
| `--restricted` | A **hard** confinement of the file tools to the working directory, not a permission decision, so it holds even if the permission layer's default answer ever changes. Also ignores user/project/local settings files. |
| `--strict-mcp-config` | Your own MCP servers must not become review tools. `--safe-mode` already drops them; this says so at the flag that owns the question. |
| `--json` (codex) | **Purely to count tool use.** Codex needs no new power: `--sandbox read-only` has always given it a shell it could read the tree with, so the ordinary tool-less call was already agentic. `--json` makes its `command_execution` events countable; the answer still comes from `--output-last-message`. |

**Verified read-only, both CLIs** — asked to create a file, run a shell
command, and read an absolute path outside the repo, over a real bridge started
with *neither* `--allow-write` nor `--allow-checkout`:

| Attempt | claude | codex |
| --- | --- | --- |
| Create a file | refused — no file-creation tool exists in the process | refused — sandbox is read-only |
| Run a shell command | refused — no shell tool exists in the process | runs, but cannot write |
| Read outside the repo root | refused, and recorded in `permission_denials` | refused — "outside the workspace root" |

The working tree was byte-identical afterwards. Note the honest difference:
claude's toolset is *narrowed by name*, so writing is absent rather than denied;
codex's cannot be narrowed, so it **does** run shell commands — it simply
cannot write with them or reach outside the root.

#### What bounds an agentic run

There is **no tool-call budget**, and that is deliberate rather than an
oversight. review123's own deep-review loop bounds itself with
`DEEP_REVIEW_MAX_TOOL_CALLS` because *it* drives the loop; here the CLI owns
its loop, and neither CLI exposes a max-turns or max-tool-calls flag. A field
claiming such a budget would be a number we made up.

`claude --max-budget-usd` *is* enforced and was **rejected on evidence**: it
caps dollars on a subscription that has no per-token price, and exhausting it
fails the whole run (`subtype: "error_max_budget_usd"`, no `result`) — throwing
away an answer already paid for. A budget that converts a finished review into
an error is not a safety feature.

What actually bounds it, all pre-existing machinery:

| Bound | Mechanism |
| --- | --- |
| Wall clock | `timeoutMs`, killed on the SIGTERM→SIGKILL ladder. Agentic runs default to `DEFAULT_AGENTIC_INFER_TIMEOUT_MS` (5 min) instead of 2, under the **same** `MAX_INFER_TIMEOUT_MS` ceiling. |
| Output bytes | `MAX_INFER_OUTPUT_BYTES`, which kills the child. |
| Filesystem reach | The CLI's own confinement to the served root (table above). |

Everything else is **reported** rather than claimed, in `InferResponse.agentic`:
the tools granted, a deliberately *under-counted* lower bound on tool calls, and
how many calls the CLI's own permission layer refused.

#### `inferAgentic` is load-bearing

`agentic` is an additive request field, so a bridge predating it does **not**
reject it — it ignores the field, runs the ordinary tool-less completion, and
answers `200` with a perfectly good single-pass review. Presenting that as a
review grounded in your working tree would be a lie nobody downstream could
detect. So clients check `capabilities.inferAgentic` *before* offering deep
review, and `InferResponse.agentic` is absent from any run that was not
actually agentic.

#### Choosing the model

Both CLIs take `--model`, verified against the same versions:

| CLI | Flag | What it accepts |
| --- | --- | --- |
| `claude` 2.1.278 | `--model <model>` | An alias for the latest model (`fable`, `opus`, `sonnet`) **or** a full name (`claude-fable-5`), per its own `--help`. |
| `codex-cli` | `codex exec -m, --model <MODEL>` | "Model the agent should use." The bridge passes the long form. |

The bridge does **not** validate the id against a list of known models: neither
CLI publishes a stable enumeration, so a baked-in allowlist would be wrong
within a month and would reject models that work. It checks the *shape* only —
letters, digits and `. _ : / -`, not starting with `-` — because this is the one
caller-supplied string that reaches argv, and a value like
`--dangerously-skip-permissions` must not be able to arrive as a flag. An id
that is well-formed but unknown is rejected by the CLI itself, with the CLI's
own error, which is the more useful message.

#### Honest limitations

- **`maxOutputTokens` is ignored.** Neither CLI exposes an output-token cap in
  headless mode. The field stays in the contract because a future release may,
  and callers should keep sending their intent — but today the bridge cannot
  enforce it and does not pretend to.
- **Model selection is a passthrough, not a catalog.** `model` becomes
  `--model <id>` on both CLIs (see above). The bridge cannot tell you which ids
  your CLI accepts, and omitting the field keeps the previous behaviour exactly:
  whichever model your CLI is configured for is the one that answers.
- **`usage` is absent for `codex`.** `claude -p --output-format json` reports
  token counts, `codex exec` does not report them machine-readably. An absent
  `usage` means *unknown* — never zero. review123 shows tokens-unknown rather
  than implying the call was free.
- **No agentic tool loop.** `claude -p` is already an agent with its own tools;
  driving it from review123's tool loop would be two tool vocabularies talking
  through a text pipe. Deep review stays on the API transports.
- **Strict JSON is prompt-enforced.** A CLI has no JSON mode, so review123
  appends a format instruction and runs the answer through its existing
  extract-and-repair ladder.

### `POST /v1/infer/stream` — implemented

The same work as `/v1/infer`, delivered as the model produces it, so the
summary and Ask panels type out instead of appearing all at once after the
wait. Same request body, same clamps, same confinement, same gates.

#### Why NDJSON and not Server-Sent Events

The response is **newline-delimited JSON** — one complete JSON document per
`\n`-terminated line — with `Content-Type: application/x-ndjson`. Four reasons,
heaviest first:

1. **`EventSource` is unusable here anyway.** It cannot send an `Authorization`
   header and cannot POST a body, and this route needs both. So a browser reads
   the response with `fetch` plus a `ReadableStream` reader either way — which
   strips SSE of the one thing it was going to buy.
2. **SSE's auto-reconnect is actively wrong for this route.** A reconnect would
   re-POST and spawn a *second* CLI run, spending the user's subscription twice
   for one answer. NDJSON has no such behaviour to disable.
3. **`data:` fields cannot contain a raw newline.** Model output is full of
   them, so every delta would have to be split across continuation lines and
   rejoined. NDJSON carries newlines inside the JSON string escape.
4. **Everything else already speaks it.** Both CLIs emit NDJSON natively
   (`claude --output-format stream-json`, `codex exec --json`) and every other
   bridge route speaks JSON. One framing end to end, one parser, one error
   envelope.

#### The events

```jsonc
{"type":"start","cli":"claude","streaming":true}
{"type":"delta","text":"Hello"}
{"type":"delta","text":", world"}
{"type":"done","text":"Hello, world","truncated":false,"durationMs":1850,
 "usage":{"inputTokens":467,"outputTokens":41}}
```

- **`start`** always precedes any delta. `streaming` is the honesty field:
  `true` when the CLI genuinely emits text as the model writes it, `false` when
  the bridge fell back to that CLI's one-shot path and the whole answer will
  arrive in a single delta at the end. **The bridge never chops a finished
  answer into timed fragments** to look like streaming.
- **`delta`** carries a piece of assistant text, in order. Concatenated they
  form the answer.
- **`done`** terminates the stream. Its `text` is the CLI's own final answer and
  is **authoritative** over the concatenated deltas — the deltas are for
  rendering progress; the result document is what the CLI committed to.
  `usage` is present only when the CLI reported it (see below).
- **`error`** — `{"type":"error","error":"<code>","message":"…"}` — carries the
  same `BridgeErrorCode` the one-shot route would have returned as a status. It
  may be the first line (nothing ran) or arrive after deltas (the child died,
  the budget expired). Either way it is terminal.

**A stream that ends without `done` or `error` was cut**, and a client must
treat that as a failure rather than as a short answer. review123's transport
does.

#### The status line is the pivot

Everything decidable **before** the CLI starts is a real HTTP status: `401`,
`403 forbidden-origin` / `forbidden-host`, `413`, `400 bad-request`,
`503 cli-unavailable`, `405` on a non-POST. Everything **after** it is a 200
carrying an NDJSON `error` event, because the status line is already spent.
That is the one real cost of streaming, and it is why the error event carries
the code the status would have.

The gate ladder is **the same ladder**, not a copy: `handler.ts` factors gates
1–5 into `checkGates()` and both routes run it.

#### Verified streaming invocations

Checked against **claude 2.1.278** and **codex-cli 0.155.1** by running
`--help` and real calls:

```sh
claude -p --output-format stream-json --include-partial-messages --verbose \
       --tools "" --permission-prompts none --safe-mode \
       --system-prompt-file <tmp>                    # prompt on stdin
```

| Flag | Why |
| --- | --- |
| `--output-format stream-json` | Emits one JSON document per line as the turn proceeds. |
| `--include-partial-messages` | Turns a per-*message* event log into a per-*chunk* one. Without it the only assistant event is the finished message — non-streaming with extra steps. |
| `--verbose` | **Not optional.** `claude 2.1.278` exits with `When using --print, --output-format=stream-json requires --verbose`. |

Every safety flag is **identical** to the one-shot invocation. Streaming
changes how the answer is delivered, never what the child may do — `--tools ""`
still disables every tool, `--safe-mode` still drops `CLAUDE.md`, hooks,
plugins and MCP servers.

The bridge reads two line shapes and skips everything else (init banners,
status pings, tool events, rate-limit notices):

```jsonc
{"type":"stream_event","event":{"type":"content_block_delta",
 "delta":{"type":"text_delta","text":"…"}}}          // → a delta
{"type":"result","subtype":"success","is_error":false,
 "result":"…","usage":{…}}                            // → the final answer
```

A `thinking_delta` is **not** streamed: it is the model's private reasoning,
not its answer, and emitting it would put text in the panel that the final
result does not contain.

**`codex` cannot stream, and the bridge says so rather than faking it.**
`codex exec --json` emits NDJSON too, but the assistant text arrives in exactly
one `{"type":"item.completed","item":{"type":"agent_message","text":"…"}}`
event containing the whole finished message; `codex exec` has no
partial-message flag. So `/v1/infer/stream` runs codex through the ordinary
one-shot path and sets `streaming: false` on its `start` event. review123's
settings page repeats that fact to the user, because "my answers don't type
out" otherwise looks like a bug.

#### Cancellation reaches the child process

**Closing the connection stops the work.** The browser aborting the fetch (or
closing the tab) tears down the socket; the bridge turns that into an
`AbortSignal` and kills the child on the same `SIGTERM` → `SIGKILL`-after-2s
ladder the timeout uses, then waits for `'close'` — i.e. for the child to be
*reaped* — before the request is over. An aborted stream emits no terminal
event at all: nobody is listening, and a verdict written into a closed socket
would only invite a caller to log a failure for a request it cancelled itself.

**This now applies to `/v1/infer` too.** Before, a cancelled inference only
closed the socket and `claude -p` kept running on your machine, on your
subscription, until it finished or burned the whole per-call budget. One
mechanism serves both routes.

`/v1/fix` is deliberately **not** wired to it: it writes commits in a scratch
worktree, and killing it mid-round is a different design question (what state
the worktree is left in) than cancelling a read-only completion.

#### Honest limitations

- `usage` is still absent for `codex`, and still absent whenever the CLI did not
  report it. Never zero-filled.
- A run cut at `MAX_INFER_OUTPUT_BYTES` ends with `done` and `truncated: true`
  carrying **the real partial text** — which is strictly better than the
  one-shot route can manage, since there the truncated JSON is unparseable and
  the answer is lost entirely.
- `maxOutputTokens` is ignored here exactly as it is on `/v1/infer`. `model`,
  by contrast, is honoured identically: both routes build their argv through the
  same `buildInvocation`, so a review cannot change model just because the CLI
  happened to support partial output.

### `POST /v1/files` — implemented

Read file contents from the actual working tree — no 20k-line cap, no API quota,
and files that are not part of the PR diff.

```ts
interface FilesRequest {
  paths: string[]           // repo-relative, confined to the root; max 200
  maxBytes?: number         // per file; clamped to 2 MiB
}

interface FilesResponse {
  ok: true
  files: {
    path: string            // echoed back exactly as you asked for it
    bytes: number           // size on disk, NOT of `content`
    truncated: boolean
    content: string
    encoding: 'utf-8'
  }[]
  missing: string[]         // requested but absent — not an error
  skipped: { path: string; reason: 'binary' | 'not-a-file' | 'unreadable' }[]
}
```

**Every** path goes through the confinement check (§4), one at a time, before
anything is opened — and one bad path fails the **whole** request with `403
forbidden-path` rather than quietly dropping out of the results. A caller must
never be able to mistake *refused* for *missing*.

A requested path lands in exactly one of the three buckets, never two:

- `files` — readable text. `truncated` is honest, including when the response's
  4 MiB total budget (not the per-file cap) was what cut it. A cut that lands
  mid-codepoint drops the incomplete sequence rather than emitting a `U+FFFD`
  the user's file never contained.
- `missing` — nothing is there. Per the contract this is **not** an error.
- `skipped` — something is there but it yields no text. A `binary` file (a NUL
  in the first 8 KB, the same heuristic git uses) is reported, never decoded:
  handing a reviewer mojibake and calling it source is worse than saying
  nothing. `skipped` is **additive within v1** — a client that reads only
  `files` and `missing` still works, it just cannot explain the gap.

### `POST /v1/search` — implemented

Content search across the working tree, replacing the rate-limited provider
code-search.

```ts
interface SearchRequest {
  query: string             // literal by default
  regex?: boolean
  caseSensitive?: boolean   // default: insensitive
  maxResults?: number       // default 200, ceiling 1000
  include?: string[]        // repo-relative globs; max 20
}

interface SearchResponse {
  ok: true
  matches: { path: string; line: number; column: number; preview: string }[]
  truncated: boolean
}
```

`line` and `column` are **1-based**, and `column` counts characters, not bytes.
`truncated` covers all three ways a result set gets cut — `maxResults`, the
20 000-file scan budget, and the 15 s wall clock — as one honest boolean,
because a caller's response to each is the same: *there may be more*.

**Two backends, one contract.** `ripgrep` is used when `rg` is on `PATH`
(faster, and it implements `.gitignore` properly); otherwise a bounded JS walk
applies the documented common subset — comments, `!` negation, trailing `/`,
leading `/`, `*`/`?`/`**`, `[abc]`, nested `.gitignore` files, last-match-wins.
Not supported: `.git/info/exclude`, the global `core.excludesFile`, and rules
from directories above the served root. A miss means the fallback searches a
file git would have ignored — noisier, never wrong, and never outside the repo.
Neither backend follows a symlink, and `.git` and `node_modules` are always
skipped. If `rg` is present but fails, the walker runs instead and the caller
cannot tell the difference.

A malformed `regex` is a `400` you can act on, not a mystery two layers down.

### `POST /v1/commits` — implemented

Ask which of a list of commits this repository already **has**. A read: no
grant, no flag, no network.

```ts
interface CommitsRequest {
  shas: string[]            // full 40-hex commit ids, max 64
}

interface CommitsResponse {
  ok: true
  present: string[]         // the subset this object store holds, as COMMITS
}
```

**Why it exists.** `POST /v1/fix` and `POST /v1/ci-fix` create their scratch
worktree with `git worktree add … <headSha>`, which materialises the commit out
of the **local object store**. Nothing about that requires your working tree to
be sitting on it. Before this route the browser could only ask `/v1/health`
where `HEAD` is and compare for equality — a stricter test than the one the
worktree actually needs — so a queue of twenty of your own pull requests could
offer the fix loop on at most **one** row. This route asks the question the
mechanism asks.

**It does not fetch.** The answer is `git rev-parse --verify --quiet
<sha>^{commit}`, once per sha, against what is on disk. A commit this repository
has never seen comes back **absent**, and review123 names the one command that
fixes that (`git fetch origin <sha>`) or offers `/v1/checkout`, which is a
different route behind a different grant (§8). Reaching a remote is a different
act from reading what is already here, and a probe that quietly did the first
would contact a server nobody asked it to.

`^{commit}` makes the check type-exact: a tree or blob id resolves to nothing
here, because a worktree cannot be created at one.

Absent from `present` means **"cannot run here"**, never "unknown" — a probe
that answered `200` answered completely.

### `POST /v1/fix` — implemented, **`--allow-write` only**

Hand findings to your local coding agent, let it fix them in a scratch
worktree, and get back a small, attributed diff. Without `--allow-write` this
route answers `403 write-disabled` — see
[§7](#7-writing-is-opt-in-at-the-command-line) for the whole safety model.

```ts
interface FixRequest {
  cli: 'claude' | 'codex'   // must appear in capabilities.inference
  headSha: string           // full 40-hex commit; the scratch worktree's base
  findings: FixFinding[]    // 1..10
  maxRounds?: number        // clamped to [1, 3]; a request may only LOWER it
  timeoutMs?: number        // per-finding CLI budget, ceiling 600 000
}

interface FixFinding {
  id: string                // YOUR opaque id, echoed back on every result
  path: string              // repo-relative; confined like every other path
  line: number | null
  severity: 'high' | 'medium' | 'low'
  body: string
  suggestedFix: string      // REQUIRED — see "the routing rule" below
}
```

There is deliberately **no `testCommand`, `cwd`, `env` or argv field.** The
test command comes from the terminal (`--test-command`) or from detection.

```ts
interface FixResponse {
  ok: true
  cli: string
  baseSha: string           // echoes headSha
  branch: string            // "review123/fix/<head12>" — in YOUR repo, unpushed
  changes: FixChange[]      // one per finding that produced a commit
  skipped: FixSkip[]        // one per finding that did not, with WHY
  rounds: number            // the most rounds any single finding needed
  stopReason: FixStopReason
  tests: FixTestOutcome | null   // the FINAL state of the branch
  durationMs: number
}

interface FixChange {
  findingId: string
  commit: string            // full sha — `git cherry-pick <commit>` just works
  subject: string
  intent: string            // the agent's own one-line account. Never invented.
  files: string[]
  diff: string              // `git show` patch, capped at 256 KiB
  truncated: boolean
  rounds: number            // 1 = right first time
  stopReason: FixStopReason // why THIS finding's loop ended
  tests: FixTestOutcome | null   // the tree AT THIS COMMIT
}

interface FixSkip {
  findingId: string
  reason: 'refused' | 'no-change' | 'agent-failed' | 'timeout'
        | 'forbidden-path' | 'budget'
  detail: string            // the agent's reason, or the bridge's
}

interface FixTestOutcome {
  status: 'passed' | 'failed' | 'unrunnable' | 'timeout' | 'skipped'
  command: string           // e.g. "pnpm test"
  durationMs: number
  output: string            // sanitized tail, 4 000 chars
  detail?: string           // why, when unrunnable/skipped
}
```

**The routing rule.** `suggestedFix` is required, and that is the rule made
structural rather than conventional: every review123 finding carries either a
concrete fix *or* an explicit `"No clean fix — <tradeoff>"`. The first kind is
mechanical and belongs to an agent; the second is a judgment call and belongs
to a person. The browser never sends the second kind, and this route could not
accept one if it tried.

**One commit per finding, always.** Findings are handled one at a time and the
*bridge* makes the commit, at the end of that finding's loop, from whatever the
agent left in the working tree. Six findings give you six independent commits,
so accepting four and rejecting two is a `git cherry-pick`, not a merge
conflict. If an agent commits anyway (it is told not to, and `claude` has no
shell), its commits are soft-reset back into the working tree first.

**Rounds are fix→re-check, per finding.** Round 1 makes the change; a further
round happens **only** when the test command then failed, and the agent gets
its own failure back to repair. The loop stops when:

| `stopReason` | meaning |
| --- | --- |
| `all-addressed` | the change was made and the tests were not failing |
| `round-cap` | 3 rounds ran and it was still red — **the commit is returned anyway, red** |
| `no-progress` | a round left the tree exactly as the previous one did |
| `repeat-diff` | a round reproduced a state an earlier round produced: oscillating |
| `budget-exhausted` | the 30-minute total wall clock expired |

On a `FixChange` it is that finding's reason; on the response it is the run's —
`budget-exhausted`, or else the strongest any finding hit, so a summary line can
never read greener than the detail under it.

**Caps.** 10 findings per request; 3 rounds per finding; 300 s per finding
(ceiling 600 s); 30 min total; 256 KiB of patch per change; 10 min and 64 KiB
per test run.

### `GET /v1/stack` — implemented

Everything the "run this PR" UI needs, in one probe. **Not** gated on
`--allow-checkout`: it only reads, and a client needs its answer — including
the flag's value — in order to *explain* why an action is unavailable. A `403`
here would leave the UI with a bare disabled button and no reason.

```jsonc
{
  "ok": true,
  "git": { "head": "9f1c…", "branch": "main", "dirty": true },
  "dirtyPaths": ["src/a.ts", "notes.md"],   // capped at 100
  "dirtyCount": 2,                          // the true total
  "prior": {                                // the recorded way home, or null
    "branch": "main",                       // null if you were detached
    "head": "9f1c…",
    "recordedAt": "2026-01-01T00:00:00.000Z",
    "checkedOutRef": "refs/pull/42/head",
    "checkedOutSha": "abc1…",
    "stashRef": "72ff…"                     // a SHA, never `stash@{0}`
  },
  "app": {
    "url": "http://localhost:8010",         // null when source is "unknown"
    "source": "posthog",                    // flag | posthog | package-json | unknown
    "reachable": true,                      // a TCP connect, just now
    "detail": "This is a PostHog checkout, …"
  },
  "checkoutEnabled": true                   // mirrors capabilities.checkout
}
```

`reachable` is always `false` when `url` is `null` — an unprobed port can never
be reported as up, the same rule `git.dirty` follows for unknown.

### `POST /v1/checkout` — implemented, **`--allow-checkout` only**

```jsonc
{
  "ref": "refs/pull/42/head",   // REQUIRED. Must start with `refs/`
  "remote": "origin",           // optional
  "stashDirty": true,           // explicit consent to `git stash push -u`
  "acknowledgeUntrusted": true  // REQUIRED. "I know this runs its code"
}
```

The `refs/` prefix is the guard that matters: argv is passed through `spawn` as
an array so nothing can become a second command, but a value beginning with `-`
could still be read by git as a **flag**. A string that must start with `refs/`
cannot be, and it covers every forge's shape — `refs/pull/<n>/head` (GitHub),
`refs/merge-requests/<n>/head` (GitLab). The **browser** supplies the ref and
the bridge just validates and fetches, so the bridge needs no case per host.

The response reports the tree afterwards, the recorded prior state, any stash
it created, and a re-probed `app` (a dev server that was up a moment ago may be
mid-reload, so the honest answer is the one measured *now*):

```jsonc
{
  "ok": true,
  "git": { "head": "abc1…", "branch": null, "dirty": false },
  "prior": { … },
  "stash": {
    "action": "created",
    "ref": "72ff…",
    "dropCommand": "git stash drop 72ffa129f5bb"   // for YOU to run
  },
  "app": { … }
}
```

### `POST /v1/restore` — implemented, **`--allow-checkout` only**

```jsonc
{
  "stashDirty": false,       // the tree is dirty NOW — stash that too
  "detachToSha": false,      // the recorded branch is gone — take the sha
  "acknowledgeMoved": false, // HEAD moved since — restore anyway
  "restoreStash": true       // `git stash apply <sha>` — never `pop`
}
```

An empty body is a legitimate plain restore. Each of the first three answers a
specific `409`; without it the bridge refuses rather than guessing.

**Caps.** 120 s for the fetch (the only network call in this package); 60 s per
local git command; 100 dirty paths reported.

### `POST /v1/ci-fix` — implemented, **`--allow-write` only**

Hands a failing CI job to the local agent, in the fix loop, **behind the
round-zero gate** described in [§10](#10-fixing-a-failing-ci-run-and-the-round-zero-gate).

```jsonc
{
  "cli": "claude",
  "headSha": "<40 hex>",       // the commit CI failed on
  "failures": [                 // 1-5 jobs
    { "id": "job:71", "name": "test (ubuntu-latest)", "log": "<= 20000 chars" }
  ],
  "maxRounds": 2                // optional; may only LOWER the cap
}
```

`log` may be empty — a job whose log the client could not fetch is still a job
that failed, and the baseline run is the signal that matters. Requiring one
would push a client towards sending *something* rather than admitting it had
nothing.

The response is a `/v1/fix` response plus three fields:

| Field | Meaning |
| --- | --- |
| `reproduction` | `reproduced` \| `not-reproduced` \| `no-local-signal`. **The field the whole route turns on.** |
| `baseline` | The unmodified test run at the head — the evidence for `reproduction`. |
| `headCommit` | The sha a `/v1/push` could carry, or `null`. Null whenever `reproduction` is not `reproduced`, structurally: no agent ran. |

Note what the response does **not** contain: any claim that CI will now pass.
The bridge ran one command on one machine.

---

### `POST /v1/push` — implemented, **`--allow-push` only**

Moves **one existing remote branch forward to one commit**. See
[§9](#9-pushing-is-a-third-grant-and-the-only-one-that-leaves-your-machine) for
what it enforces and what it deliberately does not.

```jsonc
{
  "remote": "origin",              // optional; a plain remote name
  "branch": "feat/thing",          // a plain branch name, NEVER a refs/ path
  "expectedRemoteSha": "<40 hex>", // where the branch is NOW
  "sha": "<40 hex>"                // where it should be afterwards
}
```

`expectedRemoteSha` is **required**. Without it a push is "put my commit
there", which succeeds even when the branch is not where the user was looking
when they confirmed. With it, the request states the whole plan — from this
sha, to that sha — and a branch that moved in between is a `409 remote-moved`
rather than a surprise.

There is no `force` field, and adding one would be a protocol change, not a
configuration change. That is the point.

```jsonc
{
  "ok": true,
  "remote": "origin",
  "branch": "feat/thing",
  "before": "<40 hex>",   // == expectedRemoteSha
  "after": "<40 hex>",    // == sha
  "commits": 2,
  "durationMs": 1840
}
```

**Refusals.** `403 push-disabled` (no flag) · `403 protected-branch` ·
`409 default-branch-unknown` · `404 remote-unknown` · `404 branch-missing` ·
`404 commit-unknown` · `409 tree-dirty` (with `dirtyPaths`) · `409 remote-moved` ·
`409 not-fast-forward` · `409 nothing-to-push` · `502 remote-unreachable` ·
`502 push-rejected` (git's own words) · `500 push-failed`.

The checks run cheapest-and-most-absolute first, so a request that was never
going to be allowed costs no network call and gets the *real* reason rather
than whichever failure surfaced first.

**Caps.** 60 s for the single `ls-remote`; 180 s for the push; 30 s for each
local git command.

---

The canonical TypeScript source for all of the above is
[`src/protocol.ts`](src/protocol.ts); the browser client mirrors it in
`src/lib/bridge/protocol.ts`. **Change both together.**

---

## Development

```sh
pnpm --filter @review123/bridge check   # tsc --noEmit over src + tests
pnpm --filter @review123/bridge build   # tsc -> dist/
pnpm bridge:bundle                      # esbuild -> dist/bundle/bridge.mjs
pnpm exec vitest run bridge/            # the bridge's tests only
```

The package declares **no dependencies** — Node built-ins only. Its tests run
inside the repo's single `pnpm test` suite (each spec carries a
`// @vitest-environment node` docblock), and `pnpm check` chains into its
typecheck, so CI covers it with no workflow change.

### The release bundle

`pnpm bridge:bundle` (`scripts/bundle.mjs`) bundles `src/cli.ts` into one
~160 KiB ESM file at `dist/bundle/bridge.mjs`. It is unminified, comments and
all: a file people are asked to download and run ought to be readable. `dist/`
is gitignored — the artifact is built, never committed.

esbuild is pulled through `pnpm dlx` at a **pinned** version rather than added
as a root devDependency. Only this script and the release workflow ever bundle,
so making every `pnpm install` — CI's node-22/26 matrix, the e2e job, the
Vercel deploy, every contributor — carry a ~10 MB platform binary they never
execute would re-create the exact cost the prebuilt file exists to remove.

The script refuses to build if `package.json`'s `version` and the
`BRIDGE_VERSION` constant in `src/cli.ts` disagree, so a published artifact can
never claim a version different from the one it reports in `/v1/health`.

### Cutting a release

Tag `bridge-v<version>` and push it: `.github/workflows/bridge-release.yml`
runs on that tag and **only** on that tag — it bundles and uploads the asset,
and refuses to publish when the tag does not match `package.json`. Re-running
it on an existing tag re-uploads the asset rather than failing.

It calls `node bridge/scripts/bundle.mjs` directly rather than
`pnpm bridge:bundle`, because pnpm's script runner installs the workspace
first: on a fresh runner that is the SPA's whole dev tree for a bundle that
needs none of it. Invoked directly, the script needs no `node_modules` at all.

Note that creating a release through the API (`gh release create`) also creates
the tag, which fires this workflow. That is harmless — it rebuilds the same
bytes and re-uploads them — but it does mean a "local" release still costs one
short run unless you delete the workflow's trigger first.

By hand, when Actions minutes are short (this is how `bridge-v0.1.0` was cut):

```sh
pnpm bridge:bundle
gh release create bridge-v0.1.0 bridge/dist/bundle/bridge.mjs \
  --title "review123 local bridge 0.1.0" --notes-file <notes>
```

Release notes must say what the README says above: the file binds loopback
only, requires the pairing token, and grants `https://review123.dev` **read**
access to the repo it is started in.

Since `bridge-v0.4.0` they must also say that `--allow-push` exists, that it is
**off unless typed**, and what it can and cannot do — a person deciding whether
to download a binary that might write to their team's remote should not have to
open the README to find that out. The workflow's generated notes carry that
paragraph; a hand-cut release must too.

`bridge-v0.5.0` adds `POST /v1/commits` and **needs no new grant**, because it
adds no new capability: it reads ids out of the object store. It is worth a
line in the notes anyway, because it is what makes **Fix CI** reachable from
more than one row of the queue — a 0.4.0 bridge will keep working, and will
keep offering the fix loop only on the commit your checkout happens to be
sitting on.
