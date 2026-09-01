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
