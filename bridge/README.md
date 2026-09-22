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

Protocol **v1**, complete. `GET /v1/health`, `POST /v1/infer`, `POST /v1/files`,
`POST /v1/search`, `POST /v1/fix`, `GET /v1/stack`, `POST /v1/checkout` and
`POST /v1/restore` are all implemented — nothing answers `501` any more.

- With `/v1/infer` live, review123 runs its reviews through the CLI you already
  pay for: pick **Local bridge** under Settings → AI models.
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
node ~/review123-bridge.mjs --root .
```

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
review123 bridge 0.1.0  ·  protocol v1

  repo     /Users/you/code/your-repo
  listen   http://127.0.0.1:7321   (loopback only)
  CLIs     claude, codex
  origins  https://review123.dev  http://localhost:*  http://127.0.0.1:*

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
| `--app-url <url>` | detected | Where your dev server listens, e.g. `http://localhost:8010`. Must be a **loopback** address — the bridge opens a socket to it. |
| `-h`, `--help` | — | Usage. |

There is deliberately **no flag to change the bind address**, and **no request
field, header or browser setting that can enable writing** — `--allow-write` is
typed by the person at the terminal or it does not happen. The same is true of
`--allow-checkout`, and the two are **independent in both directions**: neither
implies the other.

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

- `https://review123.dev` — exact string;
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

### What the bridge does NOT do

- **Without `--allow-write`** it does not write to your repo at all, and the
  CLIs it runs cannot either: `claude` is started with no tools whatsoever,
  `codex` with a read-only sandbox.
- **With `--allow-write`** it still never touches your working tree, your
  branch, your index or your uncommitted work, and it never pushes. See
  [§7](#7-writing-is-opt-in-at-the-command-line) for exactly what it does
  write.
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
- `infer`, `files` and `search` are **route-readiness** booleans, one per route
  and named after it. Each flips *in the same commit that implements its
  route*, so a client that trusts the flag can never call a route that is not
  there. All three are `true` — v1 is complete.
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

**`--bare` is deliberately NOT used**: it forces `ANTHROPIC_API_KEY` and never
reads the subscription, which would defeat the entire point of the bridge.

#### Honest limitations

- **`maxOutputTokens` is ignored.** Neither CLI exposes an output-token cap in
  headless mode. The field stays in the contract because a future release may,
  and callers should keep sending their intent — but today the bridge cannot
  enforce it and does not pretend to.
- **No model selection.** The request never names a model; whichever model your
  CLI is configured for is the one that answers.
- **`usage` is absent for `codex`.** `claude -p --output-format json` reports
  token counts, `codex exec` does not report them machine-readably. An absent
  `usage` means *unknown* — never zero. review123 shows tokens-unknown rather
  than implying the call was free.
- **No streaming route.** `claude -p` can stream, and a v1-compatible
  `POST /v1/infer/stream` is possible, but it needs its own event framing and
  its own mid-stream cancellation through the child process. Until then a
  streaming caller receives the whole answer at once, so the summary and Ask
  panels do not type out over the bridge.
- **No agentic tool loop.** `claude -p` is already an agent with its own tools;
  driving it from review123's tool loop would be two tool vocabularies talking
  through a text pipe. Deep review stays on the API transports.
- **Strict JSON is prompt-enforced.** A CLI has no JSON mode, so review123
  appends a format instruction and runs the answer through its existing
  extract-and-repair ladder.

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
~31 KiB ESM file at `dist/bundle/bridge.mjs`. `dist/` is gitignored — the
artifact is built, never committed.

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
