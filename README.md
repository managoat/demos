# Fountain Workbench

A dev workstation on the [Fountain](https://github.com/BinaryBourbon/fountain) API,
shared between people.

**Projects → work items → teammates.** A project is an environment and a
vault — the computer its work gets. You work on "fix foo" in project Fountain,
pull teammates into it, and talk to each one. The team is simply the project
owner's Fountain agents; adding a teammate to a work item is picking an agent,
and then you prompt.

**Assigning is one step, not four.** Starting a conversation is what puts a
teammate on a work item — the server does it (`server/proxy.ts`) — so nothing
has to be added first. The new-work-item form takes a teammate and a first
prompt, so "fix foo, Coder, here is the repro" is one submit and lands you in
the thread. On an item that already exists, the whole team is a row of chips
under its teammates: click one and write the prompt. ("+" on a chip only
earmarks them, for an item you are staffing before there is anything to say.)

**Sharing.** A project has an owner and members. Everyone signs in with
Fountain; the owner shares a project by email, and it appears for that person
the next time they sign in. Members see the same work items and the same
conversations, and start their own — and every conversation in the project
runs on the **owner's** Fountain account: the owner's agents, environments,
vaults, computers and bill. A member never holds the owner's key; the
workbench server does, and lets the member through only to that project's
conversations.

Each teammate's conversation gets its own computer, and a computer belongs
to the work item it was started for — the checkout and the disk are that
item's context, so the sidebar reads work item → computers → conversations.
When a Fountain supports it (ADR 0023, *one sandbox, many conversations*),
"**+**" on a computer that is already up opens a second conversation with
the same teammate on the same machine, on the same item: shared checkout and
disk, separate transcript. (Fountain itself would share the machine by
identity alone; the item rule is the workbench's, enforced by its server.) Against an older
Fountain the button still works; the conversation starts on a new computer and
the app says so. The sandbox identity `(owner, agent, environment, vault)`
falls out of the tree — same project, same agent — which is what makes sharing
a computer legal, whichever member opens the second conversation.

**Themes.** The top bar's ☀/☾/◐ opens a colour-scheme menu the way an editor
has one: follow the OS, or pick a palette — solarized, nord, dracula, gruvbox,
tokyo night, one dark, catppuccin latte. Hovering a line previews it on the
whole app; the choice is per browser. Every colour in the app comes from the
tokens at the top of `src/styles.css`, so a new theme is one block of them
there plus an entry in `src/lib/theme.ts`.

Hosted at **https://workbench.inevitable.fyi/** against
`https://fountain.inevitable.fyi` — sign in with your account there.

## How it works

```
browser ──(session cookie)──▶ workbench server ──(owner's Fountain key)──▶ Fountain
```

- **Sign-in** is Fountain's: "Sign in with Fountain" (OAuth 2.0 authorization
  code + PKCE) or a pasted API key. The browser hands the key to the server
  once (`POST /api/session`); the server asks Fountain who it belongs to
  (`GET /api/auth/me`), records the user by that email, keeps the key
  (AES-GCM under `WORKBENCH_SECRET`) and answers with an HttpOnly session
  cookie. Signing out ends the session but keeps the key, so a shared project
  does not stop when its owner closes a tab; every sign-in replaces it, and it
  is revocable in Fountain under Account → API keys.
- **The tree** — projects (owner, members, environment, vault) and work items
  (teammates) — lives in the server's SQLite database, `server/db.ts`.
- **Fountain through a project.** The browser's SDK client for a project has
  base URL `/f/<project>`; the server (`server/proxy.ts`) forwards to Fountain
  on the owner's key and admits only conversations whose `channel_id` starts
  with `workbench:<project>/`: it filters the list, checks every
  per-conversation call, forces the project's environment and vault on a new
  conversation, and lets a member see only the project's environment and
  vault (the owner sees all). The owner's user-wide event stream
  (`GET /api/events/stream`) is proxied the same way, filtered per project,
  with `event: workbench` records mixed in when another member changes an
  item or a setting — so every open screen follows along.
- **Recovery.** A conversation's membership is also recorded on Fountain, in
  its `channel_id`, as `workbench:<project>/<item>/<tag>` — one channel per
  conversation, because a Fountain channel binds a single conversation and a
  second one opened on it would unbind the first. So the tree is recoverable
  from the conversation list alone: "Recover from Fountain" rebuilds any project and item your
  conversations name, and listing a project's conversations fills in items
  and teammates it did not know about. A browser that held the tree from
  before the server existed is offered a one-time import (ids are kept, so
  the channels line up).

The API is reached through [`@agentshit/fountain-sdk`](https://www.npmjs.com/package/@agentshit/fountain-sdk)
in the browser (`src/lib/sse.ts` reads the user-wide stream by hand, which
the SDK does not do for a browser). The server uses plain `fetch`.

## Deploy

`.github/workflows/build.yml` builds the bundle on the runner, packages it
with the server as a Bun image (`Dockerfile`, multi-arch), pushes
`ghcr.io/jhgaylor/fountain-workbench:sha-<commit>` and pins that tag into
`k8s/deployment.yaml`. [home-cloud](https://github.com/jhgaylor/home-cloud)
runs a Flux `GitRepository` + `Kustomization` over `k8s/` (namespace, PVC,
Deployment, Service, Traefik IngressRoutes, cert-manager Certificate), so a
push to `main` is a deploy.

One replica: the database is a SQLite file on a `ReadWriteOnce` Longhorn
volume at `/data`. Configuration is by environment:

| variable           | default                          |                                                                |
| ------------------ | -------------------------------- | -------------------------------------------------------------- |
| `FOUNTAIN_URL`     | `https://fountain.inevitable.fyi` | the one Fountain everyone signs in with                         |
| `DATA_DIR`         | `./data`                         | the SQLite file, and a generated secret when none is given      |
| `WORKBENCH_SECRET` | *(generated into `DATA_DIR/secret`)* | encrypts stored Fountain keys; set it (k8s: Secret `workbench-secrets`) to keep it apart from the data |
| `PORT`             | `8080`                           |                                                                |
| `STATIC_DIR`       | `dist` if present                | the built SPA to serve; empty serves none                       |

Fountain must register the `fountain-workbench` OAuth client with this app's
origin as a redirect URI. The browser no longer calls Fountain directly, so
`API_CORS_ORIGINS` is not involved.

## Develop

Bun is the toolchain.

```bash
bun install
bun run server                       # the API + proxy on :8080 (bun --watch), data in ./data
bun run dev                          # Vite on :5173, forwarding /api and /f to :8080
bun test
bun run build                        # typecheck + bundle to dist/
bun run start                        # serve dist/ + API from one process, as in production
```

`FOUNTAIN_URL=… bun run server` points a local server at another Fountain.

## Layout

```
server/
  index.ts           Bun.serve
  app.ts             the route table
  auth.ts            sign-in: verify the key with Fountain, keep it, issue the session
  projects.ts        projects, members, items; recovery and import
  proxy.ts           Fountain as seen from inside one project, on the owner's key
  db.ts              SQLite: users, sessions, projects, members, items
  crypto.ts          keys at rest, session token hashing
shared/
  channel.ts         workbench:<project>/<item> — read and written by both sides
src/
  App.tsx            sign-in gate, OAuth callback, route switch
  store.tsx          WorkbenchProvider (me, projects) and ProjectProvider (one project's Fountain view + stream)
  router.ts          hash routes
  lib/api.ts         the server's API
  lib/workbench.ts   the model; the legacy-state import
  lib/start.ts       starting a conversation on an item — the request that also assigns the teammate
  lib/turns.ts       fold a log feed into turns for the chat view
  lib/blocks.ts      arrange server-parsed blocks (from fountain-conversations)
  lib/markdown.tsx   allow-list markdown → React nodes, no innerHTML
  lib/theme.ts       the palette list; the blocks themselves are in styles.css
  pages/             Projects, Project (items, people), WorkItem, Team
  components/        Thread, StartDialog, EnvVaultFields, Blocks, SignIn, Layout
```

## Licence

MIT.
