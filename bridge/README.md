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

Protocol **v1 — foundation**. Only `GET /v1/health` is implemented.
`POST /v1/infer`, `POST /v1/files` and `POST /v1/search` are **reserved**: their
shapes are fixed (below) and the routes answer `501 not-implemented` until the
follow-up PRs land. Nothing in the app is routed through the bridge yet.

---

## Run it

Node 22 or newer. From the repo you want to serve:

```sh
# from a review123 checkout
pnpm bridge                          # = pnpm --filter @review123/bridge start
```

Or, inside some other repo:

```sh
node /path/to/review123/bridge/dist/cli.js --root .
```

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

A local server that can read files and (later) run CLIs, reachable from a web
page, is a serious attack surface. Six rules keep it narrow. Each one has tests
in `src/*.test.ts`.

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
environment. The follow-up PR will build the process invocation itself, from
fixed shapes.

Even capability detection refuses to run anything: `capabilities.inference` is
produced by **stat-ing PATH entries for an executable file**, not by spawning
`which` and not by making a model call. Probing a CLI by running it would burn
the user's subscription quota just to render a settings page.

### 6. Caps

| Cap | Value |
| --- | --- |
| Request body | 1 MiB (`413` — enforced **while streaming**, never buffered first) |
| File bytes returned (reserved `/v1/files`) | 2 MiB per file |
| Request timeout | 30 s (`server.requestTimeout`) |
| Headers timeout | 10 s (slow-loris budget) |

### Bonus: DNS-rebinding guard

`127.0.0.1` can be reached from `http://evil.test/` if an attacker rebinds that
name's DNS to loopback — and such a request is *same-origin* to the browser, so
the `Origin` check would not fire. The `Host` header still says `evil.test`, so
the bridge requires a loopback `Host` (`127.0.0.1`, `localhost`, `[::1]`,
optionally with the port it bound) and answers `403 forbidden-host` otherwise.

### What the bridge does NOT do

- It does not write to your repo.
- It does not read anything outside the repo root.
- It does not phone home, log request bodies, or persist anything except an
  explicit `--token-file`.
- It never sends the repo's absolute path to the browser — `/v1/health`
  reports the directory **basename** only.

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
`not-implemented`, `payload-too-large`, `timeout`.

### `GET /v1/health` — implemented

```jsonc
{
  "ok": true,
  "protocol": 1,
  "root": "your-repo",          // BASENAME only, never the absolute path
  "capabilities": {
    "inference": ["claude"],    // CLIs DETECTED on PATH — see below
    "files": false,             // route READINESS — false while /v1/files 501s
    "search": false
  },
  "version": "0.1.0"
}
```

**`capabilities` has two different kinds of entry, on purpose:**

- `inference` is a **detection** signal: which of the known CLIs exist on
  `PATH`. It says nothing about whether `/v1/infer` works — that route answers
  `501` until the inference PR lands.
- `files` and `search` are **route-readiness** booleans. They are `false` in
  v1; the follow-up PRs flip each one *in the same commit that implements its
  route*, so a client that trusts the flag can never call a route that is not
  there.

**Authentication state is deliberately not reported.** The only cheap signals
("a credentials file exists", "an API-key env var is set") lie routinely —
expired sessions, keys for another account, credential helpers that keep nothing
on disk. The protocol would rather say nothing than guess. A real answer costs a
CLI invocation and belongs to the inference PR.

### `POST /v1/infer` — reserved (`501`)

Run a prompt through one of the user's local CLIs, on their subscription.

```ts
interface InferRequest {
  cli: 'claude' | 'codex'   // an ID from a hard-coded set — NEVER a command
  prompt: string
  system?: string
  files?: string[]          // repo-relative, confined to the root
  maxOutputTokens?: number
  timeoutMs?: number        // clamped by the bridge's own request timeout
}

interface InferResponse {
  ok: true
  cli: string
  text: string              // the CLI's final stdout text
  truncated: boolean
  durationMs: number
}
```

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
pnpm exec vitest run bridge/            # the bridge's tests only
```

The package declares **no dependencies** — Node built-ins only. Its tests run
inside the repo's single `pnpm test` suite (each spec carries a
`// @vitest-environment node` docblock), and `pnpm check` chains into its
typecheck, so CI covers it with no workflow change.
