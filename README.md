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

**A default teammate makes it no steps at all.** Settings & sharing has
*Default teammate* — who new work here starts with. With one set, the
explorer's composer stops being a title box: type what needs doing, press
Enter, and the item is filed *and* they are on it, with the thread open. The
first line names the item, the rest is its notes, and what you typed is what
they get (`splitAsk`, `itemAsPrompt` in `src/lib/start.ts`); leaving the
project form's prompt box empty does the same, because the work item is the
ask. That Enter spends the owner's money and boots a computer, so the composer
says whose name is on it — `↵ starts Coder on it` — and never guesses one: no
default, no start, just the item. A default naming an agent that has left the
owner's Fountain, or that the project's environment and vault no longer admit,
counts as none (`defaultTeammate` in `src/lib/workbench.ts`). Filing over MCP
still starts nobody: recording work is not spending money.

**The notes are the briefing.** A work item's notes are what whoever picks it
up starts from — a person reading the item, or a teammate reading
`list_work_items` over MCP — so they render as markdown: headings, a fenced
repro, `- [ ]` checklists, links. It is the app's own allow-list renderer
(`src/lib/markdown.tsx`, React nodes, never innerHTML), so nothing written
into an item can become markup. Writing them stays a plain textarea, and the
save follows a pause in the typing rather than every keystroke
(`src/lib/draft.ts`).

**A screenshot is a prompt.** Paste one into a composer, drop it on the
thread, or press **🖼** and pick it, and it goes with the words — "here is
what it looks like, fix it" beats describing a layout in prose. Thumbnails
sit above what you are typing until you send, each with an × ; the transcript
shows the images back on the turn they went with. The rules are Fountain's
own (`shared/images.ts`): PNG, JPEG, GIF or WebP, 10 MB an image, and a file
that breaks them is refused in the composer, by name, rather than as a failed
POST. A big one is also sent *smaller*: base64 is 4/3, so a 4K screenshot is
megabytes of JSON body for pixels nobody reads, and over 2 MB the browser
redraws it to 2000px on its long edge and sends that instead. Never a GIF — a
canvas keeps one frame — and never the re-encode when it came back bigger
than the file. It is not a way past the ceiling: a 12 MB image is still
refused, not resized into the limit. The start-a-conversation forms take them
too, on that first prompt.

The button is there because the other two ways leave people out: a touch
device has no drag and usually nothing on the clipboard, a keyboard cannot
drop a file, and a screen reader had nothing to find at all when the only
sign attaching was possible was placeholder text. It is a plain focusable
button in front of a hidden file input (`AttachButton` in
`src/components/Attachments.tsx`), on all three composers, calling the same
`useAttachments` `add` a paste and a drop call.

**Sharing.** A project has an owner and members. Everyone signs in with
Fountain; the owner shares a project by email, and it appears for that person
the next time they sign in. Members see the same work items and the same
conversations, and start their own — and every conversation in the project
runs on the **owner's** Fountain account: the owner's agents, environments,
vaults, computers and bill. A member never holds the owner's key; the
workbench server does, and lets the member through only to that project's
conversations.

**The owner pays, so the owner can see it.** Because every conversation in a
project runs on the owner's account, the owner is billed for work members
started, and had no view of what that came to. **Cost** (on the projects page,
and on a project you own) is that view: your Fountain bill for the period —
plan, turn hours, sandbox minutes — and underneath it, where the work went,
per project and per work item, so "this item burned a day of Opus" is visible
before it burns two. It is your own account and only the projects you own; a
member sees their own, never yours. It hangs off `/api/me/cost` and
deliberately not off the project proxy — that is the boundary a member
crosses, and a bill does not belong on the far side of it.

The breakdown is in the bill's own unit over the bill's own window, so it is a
division of the account figure rather than a second number beside it. A
Fountain turn carries `started_at` and `ended_at`; summing those intervals
clipped to the billing period, grouped by the work item each conversation's
channel names, is per-project **turn hours this period** — and the page shows
each project's share of the turn hours Fountain reports for the whole account,
with the difference called what it is: work on your key that no project of
yours accounts for. The arithmetic deliberately copies Fountain's own meter
(`Fountain.Billing.turn_hours_used/2`): intervals summed rather than unioned,
because two conversations each running an hour on one machine are two hours of
work; a turn still in flight accruing only as far as *now*. Tokens stay on the
page as the second unit they are — lifetime per project, and per period the
turns that finished inside it — and sandbox minutes Fountain attributes to
nothing, so neither does the page.

That costs a request per conversation: turns are per conversation and the
endpoint takes no window, so it is `GET /api/me/cost/period`, a second route
the page fetches after it has painted, rather than more of the first. Three
things keep the fan-out down, and each one reports what it did instead of
quietly shrinking the answer — only projects you own are fetched (what ran
elsewhere is the bill's figure minus this one, which is subtraction); a
conversation whose last activity predates the period cannot hold a turn inside
it and is never asked about; and turns are cached per conversation against its
turn count and last activity, so a reload re-reads only what moved. A
conversation with a turn still running is never cached — its figure grows with
the clock.

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

**And what is inside the machine.** A transcript says what an agent said; it
never said what it was *running with*. So a teammate reaches for a tool you did
not know it had, or fails to reach one you were sure it had, and there is
nowhere to look. **Details** — the top bar's ◨ while you are on a conversation,
opening a panel down the right — is that place: the teammate and model behind
the thread, the computer under it (sprite, provider, and whether it is this
conversation's own machine or the teammate's), the skills and MCP servers
loaded into it, and the permission policy actually in force. All of it was
already on the wire and none of it was on a screen. It is the explorer's
mirror, down to the dragged edge and the remembered width, because the tree
says what there is and this says what one of them is made of.

Two of those lists are the *teammate's* rather than the machine's, and the
panel says so rather than letting you assume otherwise (`src/lib/details.ts`).
Skills are written onto a sprite once, when it is built, so editing the
teammate does not reach a computer that is already up; MCP servers are re-read
at every turn, so those do follow an edit, from the next turn. And Fountain
adds to both sets without reporting either. Every sprite gets bundled skills
that are in no teammate's definition — the panel lists them, rather than
implying a shorter set than is on the disk — and a conversation whose *vault*
carries a Buzz identity gets a server of Fountain's own that no endpoint will
name, which is the one thing the panel says outright that it cannot show. (The
other two Fountain injects, the team pair, reach only a conversation on
Fountain's own `fountain:team` channel, which a workbench conversation never
is.) The policy is the merge Fountain itself performs, recomputed here: the
teammate's and the launch's, tool by tool, whichever withholds more — so a
launch can tighten it and never loosen it.

The panel is also why `GET /api/agents` stopped being a straight forward.
Fountain renders an agent whole, `mcp_servers` included, and an MCP server
configured the way this README configures one carries `Authorization: Bearer
ftn_…` in its headers — so a member's browser held the owner's key from the
moment they opened the project. Nothing read the field, so nothing showed it;
a panel that lists what is plugged in is what made an already-crossed line
visible. The proxy now replaces the values of every server's `env` and
`headers` on the way out, for the owner as much as for a member, and keeps the
names. The names are the question — what is this teammate plugged into — and
the values are the answer to nobody's.

**What happened while you were away.** A work item opens on a digest of
itself: turns finished, turns that failed, computers that went away, and —
loudest — how many agents are blocked on a permission request, each one a
click from the tool it is asking about and how long before Fountain refuses
it for you. Everything is folded out of the `stage` stream the project
already carries, so this is a client reading what it had. Counts are measured
from when this browser last opened the item (kept per item, so a reload does
not lose your place); a held request is not, because a glance at the page
must not be what makes "3 agents are blocked waiting on you" disappear.

**And you can unblock it where it asked.** An agent under an `ask` permission
stops before the tool runs, and Fountain puts the ask on the conversation as a
`permission_request` block. The transcript renders it as a card with buttons —
**exactly the options that block carried, in the runtime's order**, because
Fountain refuses an option id the runtime did not offer and the three runtimes
disagree about theirs (gemini's are `proceed_once` and `cancel`). Clicking one
is `POST /f/<project>/api/conversations/<id>/requests/<request_id>`, the same
proxy every other conversation call crosses.

The first answer wins. Another member, an editor over `fountain acp`, or the
five-minute timeout may get there first, which is a 409 — the card says so and
does not try again. It does not poll to find out, either: the resolution comes
back down the stream the page already holds open, as `request · done`, and
`src/lib/blocks.ts` folds it onto the block on `request_id` the way it already
pairs a `tool_result` to its `tool_use`. So a card closes itself whoever
answered, and one whose close was missed — a tab that was shut when it
happened — closes on the deadline instead, rather than offering buttons for a
request Fountain refused twenty minutes ago.

**Done means done.** Marking a work item done retires every conversation
still live on it, which is what takes its computers down — Fountain destroys
a sprite with the last live conversation on it, so a machine something
outside the item still holds stays up. The work is over; the disks and the
bill for them do not outlive it. The button asks first when there is
something to lose, and the app says what actually went. Reopening an item
brings nothing back: it is new conversations from there.

**Not everything gets done, and the list has to say so.** An item closes one
of two ways: **done**, "we did this", or **won't do**, "we decided not to do
this". A list that spells the second like the first cannot be read — "12
done" means nothing if some of the twelve were abandoned — so the two are
separate states (`shared/status.ts`), the project list counts them apart,
and a closed item carries which one it was wherever it appears. Otherwise
they are the same act: won't do ends the work, so it retires the item's
conversations and takes its computers down exactly as done does, asks the
same question first, and reopens the same way. Switching a closed item from
one to the other costs nothing — the machines went when it was first closed.

**The one who finds out is not the one who can close it.** An agent is usually
what discovers an item should not be done: it reads the code, the premise is
wrong, and the verdict is real work already done. It is also the one thing it
cannot record — closing an item retires every conversation on it, its own
included — so it used to end up as "we should not do this, because…" in the
notes, sitting there until a person read it: prose nothing counts and nothing
sorts, which is the problem `won't do` exists to fix, one level up. So a
verdict is a state the item carries before anyone acts on it.
`update_work_item` takes `propose: "done" | "wont"` (and `"none"` to withdraw
one), the row reads **"Coder says: won't do"**, and a person answers it —
**Confirm**, which is the ordinary close and asks first when something is
running, or **Dismiss**, which clears it and leaves the item open. Deciding
the status either way settles the proposal, because the question has been
answered. A proposal retires nothing and takes no computer down; that is why
it is a field of its own and not the status, and why the list still counts the
item as open work until a person agrees. The cheaper-looking alternative —
letting an item close while its computers stay up — is exactly what "Done
means done" is there to prevent, so it is not a shortcut, it is a different
promise.

**The board answers where the work stands.** The list says what is there;
**Board**, the other half of the toggle on a project, says where each item has
got to — one column per state, cards you can drag between them. The columns
are the point, because an item carries only three statuses and a board with
three columns is a list with gaps in it. So the open half is split by what the
app already knows from the conversation list and the item's own proposal
(`src/lib/board.ts`): **To do**, open with nothing running on it · **In
progress**, a conversation still live · **Needs you**, a teammate has proposed
a verdict nobody has answered · **Done** · **Won't do**. That third column is
what the board is for: a proposal is a question standing on an item, and until
now the only place it was counted was the row it was written on. To do holds
two different things — never started, and started and stopped without anyone
closing it — so each card says which, because its column cannot.

Deriving the columns is what stops them lying about the state, and the cost is
that most drags have no field behind them. The board is straight about which:
a column that cannot take the card you are holding says so **in the column,
while you hold it** — "In progress is not a field: an item is there while a
conversation is live on it. Start a teammate on it and it moves itself." The
refusal has to arrive before you let go rather than after, because a `dragover`
that withholds the drop is a drag the browser never fires `drop` for; there is
no later to explain in. What is left is real: dropping on **Done** or **Won't
do** closes the item, dragging a closed card back into the open half reopens
it, and dragging a verdict out of **Needs you** is the Dismiss button. When a
close would retire something live, the drag stops on a bar naming the item and
what it costs — the pointer makes that far too easy to do by accident for the
`Sure?` on a button to be enough. And dragging is never the only way: every
card carries the same close controls as a list row, so the board works from a
keyboard, and on a touch screen, which has no drag at all.

Which view you read a project in is a setting rather than a place, so it is
remembered per browser and every link back to the project — the breadcrumb,
the picker, the last tab closing — lands you in the one you chose. Naming one
(`#/p/<project>/board`) is what the toggle does, so a board is still a link you
can send.

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
the work it is on and no tool has to be told which project it means. Closing
an item — **done** or **won't do** — is deliberately not a tool: either
retires the item's conversations and takes its computers down, quite possibly
the caller's own. An agent that concludes an item should not be done proposes
that (`propose`, above) and says why in the notes; a person confirms it.

**⌘K finds anything said in the project.** A workbench whose shape is many
conversations needs one box that reaches across them, and this is it:
conversation names match locally as you type, off the list the app already
holds, and Fountain's full text over titles, prompts and replies arrives a
beat behind. Enter opens the hit — a reply or a prompt lands on the turn it
matched, marked in the margin, not at the bottom of the thread.

**⌘F finds it in the thread you are reading.** The other half, and the one a
long transcript needs: a strip under the conversation's head searches that
conversation alone, and walking the hits — ↵/⇧↵, n/N, ↑↓ — moves the transcript
to the turn that matched and marks it, rather than navigating anywhere. The
rest of the hits keep a fainter mark in the margin, so you can see what is left
to walk. It is `GET /api/search` with `conversation_id`, the tight path: the
proxy checks the id is this project's and lets Fountain scope the query, so a
keystroke fetches nothing outside the conversation. Two things it says out
loud, because neither is guessable — a reply is only searchable once its turn
*ends*, so the turn still running will not match; and matching is whole words
with `websearch` syntax (`"a quoted phrase"`, `-excluded`, `or`), which is
sharp for an identifier and blunt for prose. ⌘F is the browser's whenever the
reader is not in the thread, and always while the palette is up.

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
- **The tree** — projects (owner, members, environment, vault, default
  teammate) and work items (teammates) — lives in the server's SQLite
  database, `server/db.ts`. That file outlives the image it is served from, so
  a column added later is added by `Db.migrate`, not by the schema.
- **Fountain through a project.** The browser's SDK client for a project has
  base URL `/f/<project>`; the server (`server/proxy.ts`) forwards to Fountain
  on the owner's key and admits only conversations whose `channel_id` starts
  with `workbench:<project>/`: it filters the list, checks every
  per-conversation call, forces the project's environment and vault on a new
  conversation, cuts full-text search down to hits in the project's
  conversations, lets a member see only the project's environment and
  vault (the owner sees all), and withholds the values of every agent's MCP
  `env` and `headers` — the two fields that exist to hold credentials — while
  keeping their names. The owner's user-wide event stream
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
  cost.ts            your bill, the projects you own that it paid for, and their turn hours inside its period
  proxy.ts           Fountain as seen from inside one project, on the owner's key
  mcp.ts             the work items as MCP tools, for an agent holding a Fountain key
  db.ts              SQLite: users, sessions, projects, members, items
  crypto.ts          keys at rest, session token hashing
shared/
  channel.ts         workbench:<project>/<item> — read and written by both sides
  images.ts          an image on a prompt: the four media types, the 10 MB ceiling, the size worth re-encoding at
  status.ts          a work item's state: open, done, won't do — and the verdict a teammate proposes
src/
  App.tsx            sign-in gate, OAuth callback, route switch
  store.tsx          WorkbenchProvider (me, projects) and ProjectProvider (one project's Fountain view + stream)
  router.ts          hash routes
  lib/api.ts         the server's API
  lib/workbench.ts   the model; the legacy-state import
  lib/start.ts       starting a conversation on an item — the request that also assigns the teammate
  lib/images.ts      a pasted or dropped file, downscaled if it is worth it, read into the payload a prompt takes
  lib/search.ts      what ⌘K and ⌘F search: names locally, messages through the proxy
  lib/turns.ts       fold a log feed into turns for the chat view
  lib/digest.ts      a work item's stage stream → what happened since you last looked
  lib/details.ts     what a conversation runs with: its computer, its skills and MCP servers, the policy in force
  lib/board.ts       the items as columns, and which drags between them are real writes
  lib/blocks.ts      arrange server-parsed blocks (from fountain-conversations)
  lib/markdown.tsx   allow-list markdown → React nodes, no innerHTML
  lib/draft.ts       a field's draft and the debounced save behind it
  lib/theme.ts       the palette list; the blocks themselves are in styles.css
  pages/             Projects, Project (items as a list or a board, people), WorkItem, Team, Cost
  components/        Thread, ThreadFind (⌘F), DetailsPanel, Board, ItemDigest, Palette (⌘K), StartDialog, Attachments, EnvVaultFields, Blocks, ItemStatus, SignIn, Layout
```

## Licence

MIT.
