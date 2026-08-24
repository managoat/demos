# fountain-conversations

A standalone client for [Fountain](https://github.com/BinaryBourbon/fountain):
conversations (list, start, watch an agent work turn by turn, drive it) and
the agents, environments and vaults they run on — the user-facing pages as a
static app on its own origin, talking only to the Fountain API with an API key
you paste in once.

- **Sidebar** — every conversation beside every page, grouped the way the web
  UI grouped them (running first, then Today / Yesterday / Past 7 days /
  Older), each row the task read out of its first prompt, the agent's avatar,
  an unread dot, turn and sub-conversation counts; roots-only and per-agent
  filters.
- **Conversations** — the full table: status, task, agent, runtime, source,
  started and last-active (both sortable), terminate and delete per row. A
  **home** badge marks a conversation on a persistent sandbox (ADR 0023: the
  agent's own machine, shared by its conversations); hovering lists the others
  on it and which is mid-turn, clicking opens the machine.
- **Machine** — one sandbox: status, mode, provider, last resumed, the
  conversations on it, and *New conversation here*, which opens another one
  on the same disk (`sandbox_id`).
- **New** — agent, environment (the agent's own by default, narrowed by its
  allowlist), vault, where it runs (its own sandbox or the agent's shared
  home, when the agent carries a `sandbox_mode`), first prompt, images;
  ⌘/Ctrl+Enter to start.
- **Conversation** — *Chat* mode (bubbles, tool cards, thinking, the agent's
  avatar), *Timeline* mode (every lifecycle stage — provision, setup, turn,
  sandbox, terminate — with icons, durations, the stage's own `k=v` detail,
  the turn's prompt and output nested under it) and *Raw* mode (the bytes as
  stored, `reattach` included); per-stream toggles for `acp` / `stdout` /
  `stderr` / `stage`; follow-up prompts with images; interrupt, terminate,
  delete; the sandbox's provider, runner and preview URL; token usage; the
  spawn tree drawn as a graph, with sub-conversation navigation; a link to
  the raw log.
- **Keyboard** — `?` for the sheet, `g c` / `g l` / `g a` / `g e` / `g v` to
  jump, Enter to send.
- **Logs** — the raw event rows as stored, tailing live, filterable by stream
  and text.
- **Agents** — list, search, filter by runtime; create/edit with runtime, model
  (suggestions from `GET /api/catalog`), system prompt, environment, sandbox
  provider, skills (GitHub via skills.sh or inline SKILL.md), MCP servers,
  launch-time allowlists for environments and vaults, avatar upload or
  generation (`POST /api/avatars/generate`).
- **Environments** — list; create/edit with packages, env vars, repositories,
  setup script, network policy; secrets set/deleted (write-only, encrypted at
  rest).
- **Vaults** — list; create/edit with secrets.

Nothing here parses a runtime's output. Fountain serves every event with
**server-parsed blocks** (`?blocks=true` — text, thinking, tool_use,
tool_result, init, result, error, raw), the same parse its own web UI
renders, so this client only arranges them (`src/lib/blocks.ts`).

## Run it

```bash
bun install
bun run dev        # http://localhost:5173
```

The theme follows your OS by default; the ◐ button in the top bar pins light
or dark.

On first load, enter your Fountain URL and **Sign in with Fountain** — it opens
Fountain to approve access and brings you back signed in, nothing to copy
(OAuth 2.0 authorization code + PKCE; the token is a 30-day API key that lists
and revokes under Account → API keys, and signing out revokes it). Pasting an
API key still works as a fallback. Everything stays in this browser's
`localStorage`; view preferences (chat/timeline, stream toggles, sort) too.

For "Sign in with Fountain" the server must register this app in
`OAUTH_CLIENTS` (client id `fountain-conversations`, redirect URI = where you
host it) as well as `API_CORS_ORIGINS`.

The Fountain server must allow the browser origin — set on the server:

```
API_CORS_ORIGINS=http://localhost:5173        # dev
API_CORS_ORIGINS=https://jakegaylor.com       # wherever you host the build
```

Off by default; it admits only a presented bearer key, never a cookie.

## Build and host

```bash
bun run build      # dist/ — static, host it anywhere
```

The only build-time knob is `VITE_BASE`, the path the files are served under
(default `/`). This repo deploys itself to GitHub Pages on every push to `main`
(`.github/workflows/pages.yml`): https://jakegaylor.com/fountain-conversations/
— so the origin to allow on the server is `https://jakegaylor.com`.

## What it uses

| In the app | API |
|---|---|
| List, unread, status | `GET /api/conversations` |
| Live updates for everything | `GET /api/events/stream?blocks=true` — one SSE connection, `Last-Event-ID` on reconnect |
| New | `POST /api/conversations` (with `sandbox_id` / `sandbox_mode`), with `GET /api/agents`, `/api/environments`, `/api/vaults` |
| Home badge, machine | `GET /api/sandboxes` (once per list), `GET /api/sandboxes/:id` |
| Transcript | `GET /api/conversations/:id/turns` + `/events?blocks=true` (paged until drained) |
| Prompt, interrupt, terminate, delete, read | `POST …/prompts`, `POST …/interrupt`, `POST …/terminate`, `DELETE`, `POST …/read` |
| Spawn tree, images | `GET …/tree`, `GET …/turns/:turn_id/images/:position` |
| Agents / environments / vaults | `/api/agents`, `/api/environments` (+ `/secrets`), `/api/vaults` (+ `/secrets`), `/api/agents/:id/avatar`, `GET /api/catalog`, `POST /api/avatars/generate` |

`EventSource` cannot send an `Authorization` header, so the stream is read
with `fetch` (`src/lib/sse.ts`). Markdown in replies is rendered by a small
allow-list renderer to React nodes (`src/lib/markdown.tsx`) — never HTML.

## Develop

```bash
bun run typecheck
bun test           # SSE parser, block arranging, markdown, routes
```

Vite + React + TypeScript, no other runtime dependencies. Bun is the toolchain.
