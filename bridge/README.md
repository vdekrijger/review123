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

Protocol **v1**. `GET /v1/health` and `POST /v1/infer` are implemented.
`POST /v1/files` and `POST /v1/search` are **reserved**: their shapes are fixed
(below) and the routes answer `501 not-implemented` until the follow-up PRs
land.

With `/v1/infer` live, review123 can run its reviews through the CLI you
already pay for: pick **Local bridge** under Settings → AI models.

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
| `-h`, `--help` | — | Usage. |

There is deliberately **no flag to change the bind address**.

---

## Security model

A local server that can read files and run CLIs, reachable from a web page, is a
serious attack surface. Seven rules keep it narrow. Each one has tests in
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
| File bytes returned (reserved `/v1/files`) | 2 MiB per file |
| Request RECEIVE timeout | 30 s (`server.requestTimeout`) |
| Headers timeout | 10 s (slow-loris budget) |
| `/v1/infer` per-call budget | 120 s default, 600 s ceiling |
| `/v1/infer` stdout buffered | 4 MiB, then the child is killed and `truncated: true` |
| `files` content inlined per call | 256 KiB total |

`server.requestTimeout` bounds how long a client may take to **send** a request,
not how long the bridge may take to answer — which is why a multi-minute CLI
turn is legal under a 30 s receive budget. The inference budget is separate,
enforced by killing the child (`SIGTERM`, then `SIGKILL` after 2 s).

### Bonus: DNS-rebinding guard

`127.0.0.1` can be reached from `http://evil.test/` if an attacker rebinds that
name's DNS to loopback — and such a request is *same-origin* to the browser, so
the `Origin` check would not fire. The `Host` header still says `evil.test`, so
the bridge requires a loopback `Host` (`127.0.0.1`, `localhost`, `[::1]`,
optionally with the port it bound) and answers `403 forbidden-host` otherwise.

### What the bridge does NOT do

- It does not write to your repo. The CLIs it runs cannot either: `claude` is
  started with no tools at all, `codex` with a read-only sandbox.
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
`cli-failed`.

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
    "infer": true,              // route READINESS — /v1/infer is implemented
    "files": false,             // route READINESS — false while /v1/files 501s
    "search": false
  },
  "version": "0.1.0"
}
```

**`capabilities` has two different kinds of entry, on purpose:**

- `inference` is a **detection** signal: which of the known CLIs exist on
  `PATH`. It says nothing about whether the route works.
- `infer`, `files` and `search` are **route-readiness** booleans, one per route
  and named after it. Each flips *in the same commit that implements its
  route*, so a client that trusts the flag can never call a route that is not
  there. `infer` is `true`; `files`/`search` are still `false`.

`infer` is `true` **even when `inference` is empty**, and that is not a bug: the
two answer different questions. `infer` says "this bridge understands the
route"; `inference` says "and here is what it could run". A client needs both —
and asking for a CLI that is not installed gets a precise `cli-unavailable`
rather than a confusing `501`.

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

### `POST /v1/files` — reserved (`501`)

Read file contents from the actual working tree — no 20k-line cap, no API quota,
and files that are not part of the PR diff.

```ts
interface FilesRequest {
  paths: string[]           // repo-relative, confined to the root
  maxBytes?: number         // per file; clamped to 2 MiB
}

interface FilesResponse {
  ok: true
  files: {
    path: string
    bytes: number           // size on disk, NOT of `content`
    truncated: boolean
    content: string
    encoding: 'utf-8'
  }[]
  missing: string[]         // requested but absent — not an error
}
```

### `POST /v1/search` — reserved (`501`)

Content search across the working tree, replacing the rate-limited provider
code-search.

```ts
interface SearchRequest {
  query: string
  regex?: boolean
  caseSensitive?: boolean
  maxResults?: number       // clamped by the bridge
  include?: string[]        // repo-relative globs
}

interface SearchResponse {
  ok: true
  matches: { path: string; line: number; column: number; preview: string }[]
  truncated: boolean
}
```

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
and refuses to publish when the tag does not match `package.json`. It needs no
`pnpm install`, so it costs about a minute of Actions time.

By hand, when Actions minutes are short (this is how `bridge-v0.1.0` was cut):

```sh
pnpm bridge:bundle
gh release create bridge-v0.1.0 bridge/dist/bundle/bridge.mjs \
  --title "review123 local bridge 0.1.0" --notes-file <notes>
```

Release notes must say what the README says above: the file binds loopback
only, requires the pairing token, and grants `https://review123.dev` **read**
access to the repo it is started in.
