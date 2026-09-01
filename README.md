# Salon

**[salon.demo.managoat.com](https://salon.demo.managoat.com)** — multiplayer
chat on the [Fountain](https://github.com/BinaryBourbon/fountain) API.

Sign in with Fountain. Pick a model, say something, and a chat starts on your
account — on a real computer, with whatever your agents already know how to
do. Invite people by email or by link; they read and write the same thread,
and you pay for it. The interface is the one the desktop apps taught: no
"choose an agent, choose an environment" form, a box you type into and a pill
that says which model.

## What it does

- **Settings, not setup.** The composer has a model pill (`Opus 5 · Claude
  Code ⌄`, with a runtime submenu and "more models") and a `+` menu that
  adds a *preset* (one of your agents: its prompt, skills and servers), a
  *computer* (an environment), *secrets* (a vault), an image, or people.
  Everything is optional. Enter starts the chat.
- **Presets are agents; the rest is derived.** A preset picked on its own
  model is used as it is. Change the model, or pick none, and the server
  materialises an agent for that combination once (`Salon · Coder · Opus 5`)
  and finds it again next time by `metadata.salon.key`. The presets menu
  hides those. (`server/agents.ts`)
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
shared/   what both sides agree on: author tags, models, settings, images
src/      Vite + React: sign-in, sidebar, the composer and its menus, the thread
k8s/      Deployment + Service + IngressRoutes + Certificate for home-cloud
```

MIT.
