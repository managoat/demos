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

**A screenshot is a prompt.** Paste one into a composer or drop it on the
thread and it goes with the words — "here is what it looks like, fix it"
beats describing a layout in prose. Thumbnails sit above what you are typing
until you send, each with an × ; the transcript shows the images back on the
turn they went with. The rules are Fountain's own (`shared/images.ts`): PNG,
JPEG, GIF or WebP, 10 MB an image, and a file that breaks them is refused in
the composer, by name, rather than as a failed POST. The start-a-conversation
forms take them too, on that first prompt.

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
That tree holds still: every level ranks on when it *started*, not on which
row last printed a line, so two agents talking at once no longer shuffle the
explorer under your pointer. A turn in flight shows as a dot on its row, and
things move only when you move them. The row at the top of the tree starts a
work item where you read them: type a title, press Enter, and it is in the
list — the composer stays open for the next one, and the page you are on does
not move.
When a Fountain supports it (ADR 0023, *one sandbox, many conversations*),
"**+**" on a computer that is already up opens a second conversation with
the same teammate on the same machine, on the same item: shared checkout and
disk, separate transcript. (Fountain itself would share the machine by
identity alone; the item rule is the workbench's, enforced by its server.) Against an older
Fountain the button still works; the conversation starts on a new computer and
the app says so. The sandbox identity `(owner, agent, environment, vault)`
falls out of the tree — same project, same agent — which is what makes sharing
a computer legal, whichever member opens the second conversation.

**Done means done.** Marking a work item done retires every conversation
still live on it, which is what takes its computers down — Fountain destroys
a sprite with the last live conversation on it, so a machine something
outside the item still holds stays up. The work is over; the disks and the
bill for them do not outlive it. The button asks first when there is
something to lose, and the app says what actually went. Reopening an item
brings nothing back: it is new conversations from there.

**A teammate can file the work itself.** `POST /mcp` is the work-item tree as
MCP tools — `list_projects`, `list_work_items`, `create_work_item`,
`update_work_item` — so "split this into three items" is something the agent
you are talking to can just do, and the sidebar fills in while it answers.
Authentication is a Fountain key in `Authorization: Bearer …`, which is what a
sandbox already holds in `$FOUNTAIN_TOKEN`: the workbench asks Fountain whose
key it is and gets that person's projects, exactly as sign-in does. A key
whose email has never signed in here is refused. Send
`X-Fountain-Conversation-Id` as well and the session is pinned to that
conversation's project — read off its `channel_id` — so a sandbox reaches only
the work it is on and no tool has to be told which project it means. Marking
an item **done** is deliberately not a tool: that retires the item's
conversations and takes its computers down, quite possibly the caller's own.

**⌘K finds anything said in the project.** A workbench whose shape is many
conversations needs one box that reaches across them, and this is it:
conversation names match locally as you type, off the list the app already
holds, and Fountain's full text over titles, prompts and replies arrives a
beat behind. Enter opens the hit — a reply or a prompt lands on the turn it
matched, marked in the margin, not at the bottom of the thread.

Search is the sharpest edge of running on the owner's key: `GET /api/search`
answers for the owner's *whole account* — their other projects, and personal
conversations that are nobody else's business. So the proxy narrows it, and
the decision it turns on is recorded in `server/proxy.ts`. In short: a hit is
kept only when its conversation's `channel_id` places it in this project,
which is the rule the event stream already crosses this proxy under. Fountain
can scope a query to one conversation but not to a set, so scoping on the way
out would be a request per conversation per keystroke; it *is* used for the
one case it fits, a search inside a named conversation. Because Fountain's
`limit`/`offset` count the owner's hits rather than the project's, the proxy
pages upstream itself and serves its own window — and says so rather than
saying "no results" when it stops digging.

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
  conversation, cuts full-text search down to hits in the project's
  conversations, and lets a member see only the project's environment and
  vault (the owner sees all). The owner's user-wide event stream
  (`GET /api/events/stream`) is proxied the same way, filtered per project,
  with `event: workbench` records mixed in when another member changes an
  item or a setting — so every open screen follows along.
- **The MCP server** (`server/mcp.ts`) is `POST /mcp`: streamable HTTP, one
  JSON-RPC message per POST, the shape Fountain's own MCP endpoints use. It
  reaches Fountain only to ask who a key belongs to (`GET /api/auth/me`) and,
  when the caller names a conversation, to read that one conversation on the
  caller's own key; everything else it answers from the workbench's own
  database. It is not a second way into Fountain — `server/proxy.ts` stays the
  only boundary a member's conversations cross.

  Point a teammate at it by putting it on the Fountain agent, which gives the
  key-holder's whole tree (tools take a `project` argument):

  ```json
  { "mcp_servers": { "workbench": {
      "type": "http",
      "url": "https://workbench.inevitable.fyi/mcp",
      "headers": { "Authorization": "Bearer ftn_…" }
  } } }
  ```

  The pinned mode is the better one and needs Fountain to inject the server
  per conversation, the way it already does for the team tools
  (`Fountain.Team.conversation_mcp_servers/2`): only there do the sandbox's own
  per-conversation token and `X-Fountain-Conversation-Id` reach the headers.
  This side is ready for it.

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
  mcp.ts             the work items as MCP tools, for an agent holding a Fountain key
  db.ts              SQLite: users, sessions, projects, members, items
  crypto.ts          keys at rest, session token hashing
shared/
  channel.ts         workbench:<project>/<item> — read and written by both sides
  images.ts          an image on a prompt: the four media types, the 10 MB ceiling
src/
  App.tsx            sign-in gate, OAuth callback, route switch
  store.tsx          WorkbenchProvider (me, projects) and ProjectProvider (one project's Fountain view + stream)
  router.ts          hash routes
  lib/api.ts         the server's API
  lib/workbench.ts   the model; the legacy-state import
  lib/start.ts       starting a conversation on an item — the request that also assigns the teammate
  lib/images.ts      a pasted or dropped file, read into the payload a prompt takes
  lib/search.ts      what ⌘K searches: names locally, messages through the proxy
  lib/turns.ts       fold a log feed into turns for the chat view
  lib/blocks.ts      arrange server-parsed blocks (from fountain-conversations)
  lib/markdown.tsx   allow-list markdown → React nodes, no innerHTML
  lib/theme.ts       the palette list; the blocks themselves are in styles.css
  pages/             Projects, Project (items, people), WorkItem, Team
  components/        Thread, Palette (⌘K), StartDialog, Attachments, EnvVaultFields, Blocks, SignIn, Layout
```

## Licence

MIT.
