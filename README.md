# fountain-team

A messaging-style client for your [Fountain](https://github.com/BinaryBourbon/fountain)
team: your agents as teammates, one ongoing conversation each (and, when you
want it, more threads on the same computer) — the roster on the left, the
thread on the right, Enter to send. It is the `/team` page as a
standalone app: static files, no backend of its own, talking only to the
Fountain API with an API key you paste in once.

## Run it

```bash
bun install
bun run dev        # http://localhost:5173
```

On first load, enter your Fountain URL and **Sign in with Fountain** — it opens
Fountain to approve access and brings you back signed in, nothing to copy
(OAuth 2.0 authorization code + PKCE; the token is an API key that lists and
revokes under Account → API keys, and signing out revokes it). Pasting an API
key still works as a fallback. Everything stays in this browser's
`localStorage`.

For "Sign in with Fountain" the server must register this app in
`OAUTH_CLIENTS` (client id `fountain-team`, redirect URI = where you host it)
as well as `API_CORS_ORIGINS`.

The Fountain server has to allow the browser origin — a browser calling
another site's API is a CORS request. Set on the server:

```
API_CORS_ORIGINS=http://localhost:5173        # dev
API_CORS_ORIGINS=https://jakegaylor.com       # wherever you host the build
```

That switch is off by default and only ever admits a presented bearer key —
cookies never cross origins — so turning it on for your own client is safe.

## What it does

**Adding a teammate is one click** (after Grok Bot / OpenMausBot): **+**
gives them a name from a list, Claude Sonnet as the brain (or the first
provider the account holds a key for), a short system prompt that names
them, and a generated face that arrives a moment later. Nothing to fill in.
Rename from the thread header; everything else is in **Customize** (click the
title): the brain, what they do, their **skills** and the **apps** they can
use — see below. "Add an agent you already have" (team menu ⋯) is the
advanced path for an agent built in Fountain with its own environment and
vault.

Beyond the roster and the thread — the things a messaging app is expected to
do, each on the public API:

- **Send while they're busy.** A message to a teammate mid-turn does not
  bounce: it queues in the thread (dashed bubble, ⏱ send button) and is sent
  the moment the turn ends — several queued notes go as one turn. Interrupt,
  then queue a correction, and the correction runs. Cancel a queued note from
  its bubble.
- **Images.** Paste, drop, or attach png/jpeg/gif/webp (10 MB each); they go
  with the prompt and show in the thread, fetched back from the API.
- **Notifications.** The bell in the roster header asks the browser once;
  after that a reply from a teammate you're not looking at (or in a
  background tab) raises a desktop notification that opens the thread. Mute
  a teammate from the row menu. The tab title carries the unread count.
- **Row menu** (right-click, or ⋯ on hover): pin to top, mute, mark as
  unread / read, open in Fountain, copy the conversation id, remove.
- **Drafts** survive switching teammates and reloads.
- **Reading is not interrupted.** New content only scrolls the thread when
  you were already at the bottom; otherwise a "New messages ↓" pill waits.
  Long threads render the last 40 turns with "Show earlier messages".

- **Routines** (team menu ⋯ → Routines, or from a thread header): the
  schedules that run a teammate with a prompt — in their thread or on a
  one-off computer. Presets or a custom cron (UTC), pause/resume, run now,
  edit, delete; the list follows the stream's `schedule` event.
- **⌘K** (Ctrl+K): jump to a teammate by name, a couple of commands, and
  full-text search across every conversation — pick a hit and the thread
  opens scrolled to that turn, highlighted. Hits outside the team open in
  Fountain.
- **Token usage**: per turn under the reply, and per teammate in the thread
  header (summed over every conversation they've had on the team).
- **Spawned**: when a teammate opened sub-conversations, a "Spawned · n"
  button in the thread header lists them (`/tree`).
- **Export** (team menu ⋯): the team as a `fountain apply` manifest —
  one `Agent` document per teammate; import is `fountain apply -f team.yml`.
- **Activity** (thread header): a sidebar with what the teammate is doing
  as it narrates it — prose between folded "Ran N tool calls ▾" rows that
  open to the calls with status, duration and output, per turn, live. In the
  chat itself a tool run is just a status line ("Ran Terminal 3.0s ›");
  clicking it opens Activity at that run. Built from the ACP events already
  on the stream.
- **Report a problem** (team menu ⋯, or a row's menu for "…with this
  teammate") — a category, what happened, an optional screenshot, and what
  the app knows (shown before sending: conversation, agent, sandbox,
  presence, recent stage events, app build — never agent output or keys) →
  `POST /api/support/reports`; the people running your Fountain get it as
  an issue and/or mail.
- **Markdown** in replies — headings, lists, tables, code blocks with Copy,
  links (http/https/mailto only) — rendered from a small parser in
  `src/lib/markdown.ts` to React elements, never HTML, so nothing an agent
  writes can inject markup. Roster previews show the plain text.
- **Customize a teammate** (click the thread title) — three tabs, all
  edited here on the agent behind them, nothing sends you to Fountain:
  - **Profile**: the brain (one select; the runtime follows), what they do
    (one line → description + system prompt), the **computer** — Fountain's
    cloud or **your own machine** (a select, when the server offers runners;
    it shows which of your machines are online and how to start one), and
    the details folded away.
  - **Skills**: what they have, a searchable catalog of skills.sh
    collections (Anthropic's document skills, Vercel's React guidelines,
    Superpowers' engineering workflow, …) with one-click Add, any GitHub
    repo by `owner/repo`, `@ref`, or a pasted GitHub / skills.sh link, or a
    skill written in place (a SKILL.md, editable afterwards). Stored as the
    agent's `skills`; installed on their computer with the skills.sh CLI.
  - **Apps** (after OpenMausBot's connected-apps marketplace): the MCP
    servers they can call. A catalog of hosted servers that take a token
    (GitHub, Supabase, Neon, Render, Stripe, PostHog, Hugging Face,
    Context7, Exa, Tavily, Firecrawl) or nothing (DeepWiki, Cloudflare /
    Microsoft / AWS docs), plus a couple that run on the computer (Notion,
    Brave Search) — Connect asks for the token, saves it as a secret on the
    teammate's environment (made on the spot if they have none) and writes
    the server with a `${VAR}` reference, so the agent never holds the
    value. Custom server: any URL + headers, or a command + env. A
    connected server whose `${VAR}` is missing from the environment says
    so and offers to add it.

  Skills and apps land when the teammate's computer is set up, so after a
  change the panel offers **Restart their computer** (no confirmation when
  nothing has happened on the thread yet; the usual one otherwise).
- **Keyboard**: ⌘K search, Alt+↑/↓ to switch teammates, `?` for the list.
- **Rename** a teammate (✎ by the name, or the row menu); empty resets to the
  agent's name. **History** (thread header / row menu): its previous
  conversations — earlier threads — readable in place. **Start a fresh
  thread…** (row menu / History) retires the current one and opens a new one
  on the **same computer**: the thread stays in History, the next message
  starts with a clean context, and the files and tools on the computer are
  where they were. **Fresh thread on a new computer…** is the other option:
  the current conversation and its computer are shut down and a new computer
  starts right away — the thread shows it starting, then ready.
- **Threads** — more than one conversation with a teammate on the one
  computer. Fountain lets several conversations share a sandbox as long as
  they belong to the same agent, so besides the **main thread** (the one the
  team knows) a teammate can have **side threads**: **New thread…** (row
  menu, or "+ New thread" in the strip under the thread header) opens
  another conversation on the same computer — same files, clones and tools,
  its own clean context — named on the way in ("Thread 2" by default). The
  strip switches between them; each tab carries its own presence dot and
  unread mark, the roster row shows ⧉n while a teammate has more than one,
  and the tab title counts a side thread's unread too. A side thread is
  sent to directly, queues while it is mid-turn (or, on an opencode /
  gemini computer that runs one turn at a time, while any thread is), and
  shows its own Activity, permission requests and Interrupt. **×** on the
  active tab closes it: the conversation ends and stays readable in
  Fountain; the computer and the main thread stay. Side threads are closed
  before "Fresh thread on a new computer…" and before Remove, since they
  would otherwise keep the machine up. URLs are
  `#/team/<agent>/<conversation>`.

- **Runners** (team menu ⋯): your own machines serving as a teammate's
  computer (Fountain's self-hosted runner): which are online, forget one,
  how to start `fountain runner`. To put a teammate on one: right-click them
  → **Run on your own machine…** (Customize → Computer; it reads **Run in the
  cloud…** for one already on a machine), then restart their
  computer. A teammate on a runner shows "on
  <machine> · path" in the header; when that machine is off its presence is
  *machine offline* and messages queue until the runner reconnects.

- **Email & phone for a teammate** (row menu / Customize → Profile, when the
  server offers it): **Give email & phone…** buys the teammate their own
  AgentMail inbox and AgentPhone number — for this teammate only, and
  **both are billed**, which the dialog says before Confirm. The one field
  is *your* phone number (required, any common format): texts from it to
  the teammate's new number arrive in this very thread as prompts; texts
  from any other number are ignored. From their next turn the teammate has
  email and SMS tools (`email_send`/`reply`/`list`/`get`, `sms_send`/`list`,
  served by Fountain) and answers a text by text with `sms_send`, not in the
  chat. A teammate with a contact shows it under the thread header and in
  their profile — email and number in monospace with Copy, and "Texts from
  +1 (555) … arrive here as prompts". **Release email & phone…** (there, or
  the row menu) releases the inbox and number upstream. The affordance
  appears only when `GET /api/team/comms` says the account's `team_comms`
  flag is on; when the instance has no AgentMail/AgentPhone keys it is shown
  disabled with that reason. A bad number is refused before anything is
  bought (inline, under the field); a provider refusal reads "AgentMail /
  AgentPhone refused: …". Entering the number is an SMS opt-in: the dialog
  carries the consent statement (what Fountain texts you, frequency varies,
  msg & data rates may apply, STOP to opt out, HELP for help) with the
  server's Privacy Policy and Terms links, and the button reads **Agree &
  give email & phone**. If STOP is received from your number the header
  says "Texts paused — STOP was received from +1 (555) …; text START to
  resume, or change the number"; **Change number…** (header, profile, row
  menu) swaps `prompt_from_number` and clears the opt-out. Contact changes
  ride the `team` stream event, so another tab picks them up.

Pins, mutes, marks and drafts live in this browser's `localStorage`; Fountain
has no field for them.

## Develop against a Fountain without CORS

```bash
FOUNTAIN_PROXY=https://your-fountain.example bun run dev
```

forwards `/api` from the dev server, so enter `http://localhost:5173` as the
Fountain URL and paste a key (OAuth needs the real origin).

## Build and host

```bash
bun run build      # dist/ — static, host it anywhere
```

Any static host works (Cloudflare Pages, GitHub Pages, an nginx container, an
S3 bucket). The only build-time knob is `VITE_BASE`, the path the files are
served under (default `/`); the Fountain URL is entered in the app.

This repo deploys itself to GitHub Pages on every push to `main`
(`.github/workflows/pages.yml`): https://jakegaylor.com/fountain-team/ (the
Pages site sits behind that custom domain) — so the origin to allow on the
server is `https://jakegaylor.com`.

## What it uses

Everything is the public API (`docs/api.md` in Fountain, "Team"):

| In the app | API |
|---|---|
| Roster, presence, previews, unread | `GET /api/team` |
| Add (+) | `GET /api/catalog` + `/api/account/inference-credentials` + `/api/agents` (names in use), `POST /api/agents`, `POST /api/team`; then `POST /api/avatars/generate` + `PUT /api/agents/:id/avatar` in the background |
| Customize — profile, skills, apps | `PUT /api/agents/:id` (brain, what they do, `skills`, `mcp_servers`, `environment_id`); tokens via `POST /api/environments` + `GET/POST /api/environments/:id/secrets` |
| Add — an agent you already have | `POST /api/team`, with `GET /api/agents`, `/api/environments`, `/api/vaults` for the picker |
| Send (text + images) | `POST /api/team/:agent_id/messages`; `GET /api/conversations/:id/turns/:turn_id/images/:pos` to show them back |
| Thread | `GET /api/conversations/:id/turns` + `/events` |
| Live updates | `GET /api/team/stream` — one SSE connection for the whole team, `Last-Event-ID` on reconnect |
| Read state | `POST /api/conversations/:id/read` |
| Interrupt / Remove | `POST /api/conversations/:id/interrupt`, `DELETE /api/team/:agent_id` |
| Routines | `GET /api/team/schedules`, `POST/PATCH/DELETE /api/team/:agent_id/schedules[/:id]`, `POST …/:id/run` |
| Search (⌘K) | `GET /api/search?q=` |
| Usage | `usage` on turns, `usage_total` on the roster |
| Spawned | `GET /api/conversations/:id/tree` |
| Export | `GET /api/agents/:id` + `/api/environments`, emitted as YAML client-side |
| Rename / History | `PATCH /api/team/:agent_id`, `GET /api/team/:agent_id/conversations` |
| Fresh thread (same computer / new computer) | `POST /api/team/:agent_id/conversations`; new computer: `POST /api/conversations/:id/terminate` first, then the same call (which provisions now) |
| Threads | `GET /api/conversations?status=pending,idle,running` (side threads = same agent + same `sandbox_id`, off the team channel), `POST /api/conversations` (`agent_id`, `sandbox_id`, `title`), `POST /api/conversations/:id/prompts`, `GET /api/conversations/:id/stream` for the open one, `POST /api/conversations/:id/terminate` to close |
| Runners | `GET /api/runners`, `DELETE /api/runners/:id`; `sandbox.runner` + `machine_offline` presence on the roster |
| Email & phone | `GET /api/team/comms`; `POST` / `PATCH /api/team/:agent_id/contact` (`{prompt_from_number}`), `DELETE /api/team/:agent_id/contact`; `contact` (incl. `prompt_opted_out_at`) on the roster |

`EventSource` cannot send an `Authorization` header, so the stream is read
with `fetch` and parsed in `src/lib/sse.ts`. The ACP output is turned into
bubbles in `src/lib/acp.ts`, a port of Fountain's own `ACP.Blocks`; both have
unit tests (`bun test`).

## Develop

```bash
bun run typecheck
bun test
```

Vite + React + TypeScript, no other runtime dependencies. Bun is the toolchain
(`bun install`, `bunx vite`); Node works too if you prefer it.
