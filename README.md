# Salon

**[salon.demo.managoat.com](https://salon.demo.managoat.com)** — multiplayer
chat on the [Fountain](https://github.com/BinaryBourbon/fountain) API.

Sign in with Fountain. Pick a model, say something, and a chat starts on your
account. Invite people by email or by link; they read and write the same
thread, and you pay for it. The interface is the one the desktop apps
taught: a box you type into, a pill that says which model, and a `+` menu —
nothing about agents, environments or runtimes anywhere.

## What it does

- **Settings, not setup.** The model pill is one list grouped by brand
  (Anthropic / OpenAI / Google) from Fountain's catalog; the `+` menu is
  *Add photos*, *Skills ›* (PDFs, Word documents, Spreadsheets, Slides,
  Posters & visuals — checkmark toggles), *Connectors ›* (the accounts you
  have linked on Fountain, such as Gmail, plus *Connect another…*), and
  *People ›*. Everything is optional. Enter starts the chat.
- **One agent per combination, derived.** A chat's settings are a model,
  some skills and some connectors. The server derives the agent Fountain
  needs — the runtime the model's provider implies, a prompt written for a
  chat room, the skills as skills.sh installs, the connectors as
  `mcp_servers`, no environment — once per distinct combination
  (`Salon · Opus 5 · gmail, pdf`) and finds it again by a hash in
  `metadata.salon.key`. Your own agents are never listed or touched.
  (`server/agents.ts`, `shared/settings.ts`, `shared/skills.ts`)
- **Connectors need the broker.** Connections exist only for Fountain
  accounts the egress broker is on for; elsewhere the Connectors submenu
  says so instead of showing an empty list. Google attaches as Fountain's
  own Gmail server; a remote MCP server you connected (Linear, Notion, …)
  attaches with the connection's bearer; Outlook and Slack show as not
  usable in a chat yet.
- **The host pays.** A chat is a Fountain conversation under the host's key,
  bound to `channel_id = salon:<chat>`. Guests never hold that key: their
  browser runs an ordinary SDK client whose base URL is `/f/<chat>`, a proxy
  that admits exactly that conversation on the host's key
  (`server/proxy.ts`). A guest's turn goes in tagged `[from guest@…]` so the
  model knows who is talking, and Salon records who sent each turn so the
  bubble can say so (`shared/author.ts`, `server/db.ts`).
- **Invite by email or by link.** Email: the person finds the chat waiting
  when they sign in. Link: `#/join/<token>`, anyone signed in who opens it
  joins; the host can mint a new one at any time.
- **Games, with the people in the room.** "Let's play tic-tac-toe, me
  against Bob" puts a board in the transcript for everyone. The model only
  starts it — Salon is an MCP server the chat's computer calls as the
  conversation it is running (`server/mcp.ts`), and the tool result is the
  game — and the board is Salon's own record: a move is a click by the
  player whose go it is, checked by the server (`shared/games.ts`,
  `server/games.ts`) and pushed to the other browsers on a server-sent
  stream, never a turn. The `+` at the foot of a chat starts one without
  the model too. Anthropic models only for now: the claude runtime is the
  one that carries an MCP server with headers into the computer.
- **A session in a repository, through a GitHub App.** *Repository ›* in the
  `+` menu: connect GitHub, choose one of the repositories both you and the
  Salon App installation can reach, and the chat's computer starts with a
  checkout of it on a branch of its own. No personal access token is pasted
  into Salon. The server mints a one-hour installation token narrowed to that
  one repository, refreshes Fountain's write-only clone secrets before every
  session, and installs a credential helper that can refresh a long-running
  session (`server/github.ts`, `server/github-access.ts`, `server/projects.ts`).
  Everyone in a project is in every chat started in it, and every such
  chat runs on the project owner's account, whoever starts it.
- **Changes, beside the transcript.** What the computer did to the
  repository — the branch, the files, every hunk — shows in a panel for
  everyone in the chat, live: a hook inside the computer posts a snapshot
  when a session starts, after each edit and when a turn ends
  (`server/sandbox.ts`, `server/changes.ts`, `src/components/Changes.tsx`),
  and Salon reads the repository itself through Fountain's read-only
  sandbox routes — `git diff`, and the `.git` refs — when anyone presses
  ↻ or a turn ends (`server/files.ts`). That read is not a turn, works
  whatever model the chat runs, and never wakes a parked computer.
- **Files, as they are now.** The panel's Files view browses the
  repository in the computer, one directory or one file at a time, the
  same way; *open* on a changed file shows the whole of it. Fountain
  offers no way to run a command on a computer from outside, on purpose,
  so nothing here does: to change something, say so in the chat.
- **Review together.** Anyone in the chat comments on a line of the
  changes; threads resolve; and *Send to the model* turns the open
  comments into one prompt, grouped by file with each person named, sent
  as whoever pressed it (`server/comments.ts`, `shared/comments.ts`). A
  comment costs nobody a turn; the send is one.
- **Ship from the panel.** A checks strip says what stands between the
  branch and a merge — tree clean, branch pushed, pull request open,
  comments answered — and two buttons ask the model to push or to open a
  pull request (each is a turn, and says so). Archive lets the computer
  go and keeps the chat, its changes and its comments; Restore starts it
  again on the pushed branch.
- **Blocks, not dialects.** The transcript renders Fountain's server-parsed
  blocks (`?blocks=true`): text as markdown (an allow-list renderer to React
  nodes, never innerHTML), tool calls as collapsible rows, permission
  requests as cards anyone in the room can answer.

## Run it

```bash
bun install
bun run server     # the Bun server on :8080 (FOUNTAIN_URL defaults to https://managoat.com)
bun run dev        # Vite on :5173, proxying /api and /f to the server
```

Sign in with a pasted API key while developing; "Sign in with Fountain"
needs the `salon` OAuth client registered on the Fountain you point at, with
`http://localhost:5173/` as a redirect URI.

```bash
bun run typecheck && bun test && bun run build
```

## Ship it

One container: `oven/bun:1-alpine` + `server/` + `shared/` + `dist/`, the
server serving the SPA itself. `build.yml` builds it multi-arch on push to
`main`, pushes `ghcr.io/managoat/salon`, and pins the sha into
`k8s/deployment.yaml`; Flux on home-cloud applies `k8s/`.

| Env | Meaning |
|---|---|
| `FOUNTAIN_URL` | the Fountain every user signs in with (`https://managoat.com`) |
| `DATA_DIR` | where `salon.sqlite` (and a generated secret) live; a volume |
| `SALON_SECRET` | encrypts stored Fountain keys; generated into `DATA_DIR/secret` when unset |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG` | the Salon GitHub App |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | connect a signed-in Salon user to the App so GitHub can list their installed repositories |
| `PORT`, `STATIC_DIR` | `8080`, `dist/` |

The Fountain it talks to needs two things (`docs/configuration.md` there):
`https://salon.demo.managoat.com` in `API_CORS_ORIGINS` is *not* one of them —
the browser only ever talks to this server — but the OAuth client is:
`{"id":"salon","name":"Salon","redirect_uris":["https://salon.demo.managoat.com/"]}`
in `OAUTH_CLIENTS`.

## Layout

```
server/   Bun: auth, chats, the agent seam, the chat-scoped proxy, SQLite
shared/   what both sides agree on: author tags, models, settings, skills, images
src/      Vite + React: sign-in, sidebar, the composer and its menus, the thread
k8s/      Deployment + Service + IngressRoutes + Certificate for home-cloud
```

MIT.
