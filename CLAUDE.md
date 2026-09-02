# CLAUDE.md — working on Salon

Read by Claude Code (and other agents) at session start. Keep it true.

## What this is

Multiplayer chat on the Fountain API, hosted at
**salon.demo.managoat.com**. Sign in with Fountain, pick a model, say
something, invite people by email or link. The chat is a Fountain
conversation under the **host's** key; the host pays; guests never hold that
key. The interface is deliberately the desktop-app one: a box, a model pill
(one list, grouped Anthropic / OpenAI / Google), and a `+` menu with *Add
photos · Skills › · Connectors › · People ›* — never an agent-and-environment
form. The words agent, sandbox, environment, vault, runtime, stdout, preset
and computer do not appear in anything a user reads; keep it that way.
`README.md` has the product write-up; this file has what you need to change
it safely.

The build-an-app guide lives in the Fountain repo, not here:
`~/dev/BinaryBourbon/fountain/.claude/skills/build-fountain-app/SKILL.md`
and its `references/traps.md`. It is a project skill of that checkout, so it
does not load from this directory — open it by path. The Fountain manual is
`docs/build/*.md` and `docs/sdk.md` in the same repo, or `/docs` on
managoat.com. Salon uses `@agentshit/fountain-sdk` in the browser and plain
`fetch` on the server (never the SDK server-side: a proxied call must carry
no headers of ours).

## Layout

```
server/   Bun. app.ts is the route table; index.ts boots it.
          auth.ts      sign-in: key → GET /api/auth/me → user row (key encrypted) + cookie
          menu.ts      GET /api/me/menu: the model catalog + the caller's connections (never their agents)
          connectors.ts a connection → the mcp_servers entry an agent uses, and the menu row
          agents.ts    settings → the agent Fountain runs (the seam, see below)
          chats.ts     chats, members, invites, join; a chat in a project is hosted by the project's owner
          github.ts / github-access.ts  the GitHub App: OAuth repo picker, one-repo installation tokens
          projects.ts  a selected repository → an Environment on the owner's Fountain (clone, hook, App token as a secret)
          proxy.ts     /f/<chat>/api/conversations/<id>/… on the host's key
          games.ts     a chat's games: start, move
          changes.ts   the repository's changes: the hook's POST, the latest record, `record` (the one way in)
          files.ts     the repository read through Fountain's read-only sandbox routes: refresh (a snapshot into `record`), a directory, a file
          comments.ts  review comments on a line of the changes; `send` turns the open ones into one prompt
          hub.ts       GET /api/chats/:id/stream: what Salon itself records, live (game, changes events)
          sandbox.ts   who a computer is (bearer = $FOUNTAIN_TOKEN + conversation id), and the hook setup script
          mcp.ts       POST /mcp: Salon as an MCP server for the chat's computer (start_game, game_state)
          db.ts        SQLite: users, sessions, chats, chat_members, sends, games, changes, comments, projects, project_members
shared/   what both sides agree on: author.ts, models.ts, settings.ts, skills.ts, images.ts, games.ts (the rules),
          changes.ts (the snapshot shape, and the diff/status parsers both sides use),
          files.ts (a directory listing and a file as the panel browses them; paths stay inside the repository),
          comments.ts (a comment's shape, and the prompt the open ones become),
          projects.ts (what a repository address is, where it is checked out)
src/      Vite + React. store.tsx (session), router.ts (hash routes), lib/live.ts (the chat's own stream),
          components/Thread.tsx (transcript + composer), SettingsMenu.tsx (pill + `+`),
          Game.tsx (the board), Blocks.tsx (a start_game tool block renders as the board),
          Changes.tsx (the repository panel beside the thread, with the room's comments on its lines, Refresh, and Files)
k8s/      Deployment/PVC/Service/IngressRoutes/Certificate; Flux (home-cloud) applies it
```

## Nine boundaries, easy to get wrong

1. **The proxy is the member boundary.** A guest's browser builds
   `new Fountain({ baseUrl: "<origin>/f/<chat>", apiKey: "session" })`; the
   placeholder is swapped for the host's key by `server/proxy.ts`, which
   admits *only* the chat's own conversation id and *only* the routes listed
   in `allowed()`. Anything new the browser needs from Fountain goes through
   that allow-list, with a 404 (not 403) for what the caller is not in. Never
   add a route that returns the host's key, agents' `mcp_servers`, or
   secrets to a browser.
2. **Settings → agent (`server/agents.ts`).** A chat's settings are
   `(model, skills[], connectorIds[])` (`shared/settings.ts`; `presetId` /
   `environmentId` / `vaultId` exist but nothing in `src/` sets them). The
   runtime is derived from the model's provider (`models.ts#runtimeFor`:
   anthropic → claude, openai → codex, google → gemini). One agent is derived
   per distinct tuple — `Salon · Opus 5 · gmail, pdf`, room prompt, no
   environment, the skills as skills.sh installs, the connectors as
   `mcp_servers` — and found again by `metadata.salon.key`, a FNV-1a hash of
   the sorted tuple (`settings.ts#derivedKey`, pinned by a test). Change the
   key shape and every existing derived agent is orphaned — the host's
   agent list grows by one per pick until they are cleaned up.
   Skills are the curated list in `shared/skills.ts` (`owner/repo` + skill
   name, pinned to a sha; verify a source on skills.sh before adding one).
   Connectors: Google → `{gmail: {connection}}` (Fountain's own server), a
   tenant `mcp` provider → `{type: "http", url, connection}`; Microsoft,
   Slack and `oauth2` tenant apps have no server to speak through and are
   shown as not usable. Connections exist only for accounts the egress
   broker is on for (`GET /api/connections` is a 404 `connections_not_enabled`
   elsewhere); `menu.ts` turns that into `connectors.enabled: false` and the
   menu says so.
3. **Who said what is a two-sided contract.** Once a chat has more than one
   participant the proxy rewrites a prompt to `[from email] text`
   (`shared/author.ts#withAuthor`) and records `sends(seq, email)`; the
   browser labels bubbles by tag > recorded send > host
   (`src/lib/turns.ts#authored`) and strips the tag. Change the tag format
   in `author.ts` only, and remember old transcripts carry the old one.
   `turn.origin === "autonomous"` turns are not sends; do not count them.
4. **Fountain refusals pass through with their code.** `FountainHttpError
   .toHttp()` keeps the status and `error` string (`insufficient_credits`,
   `environment_not_allowed`, …) so `src/lib/errors.ts` can say something
   useful. Do not collapse them into a 500.

5. **Games: the model starts, people play, nothing else is a turn.** The
   derived agent (claude runtime only, and only when `PUBLIC_URL` is set)
   carries `mcp_servers.salon = {type: "http", url: "<PUBLIC_URL>/mcp",
   headers: {Authorization: "Bearer $${FOUNTAIN_TOKEN}",
   "X-Fountain-Conversation-Id": "$${FOUNTAIN_CONVERSATION_ID}"}}`
   (`agents.ts#salonServer`; an agent found without it, or with an old
   address, is patched in place, so the derived key does not change). `$${…}`
   is Fountain's escape: the conversation's own key is not in the
   environment Fountain substitutes from, so the literal `${…}` must reach
   the runtime, which expands it. `server/mcp.ts` verifies the bearer with
   `GET /api/auth/me`, finds the chat by conversation id, and requires the
   key's email to be the host — then `start_game` / `game_state` reach that
   one chat. A game is a row in `games`; moves are `POST
   /api/chats/:id/games/:g/moves` from the player whose go it is, and every
   change goes out on `GET …/games/stream` (in-process hub, one replica).
   The browser draws the board from the `mcp__salon__start_game` tool block
   (`src/lib/blocks.ts#gameOf`, the live record by id), or after the last
   turn for a game the `+` started. Known Fountain quirk (2026-09-02):
   the ACP peer sends the agent's *raw* `mcp_servers` on `session/new`
   (`conversation_server.ex`, `Fountain.Runtimes.ACP.mcp_servers(...)`), so
   the runtime sees `$${X}`, expands the inner ref, and the header arrives
   as `Bearer $ftn_…`; `mcp.ts#unescaped` drops that `$`. The project
   `.mcp.json` copy is substituted correctly but the session copy wins.
   Fix it in Fountain and the tolerance becomes dead code.

6. **Changes come out of the computer two ways, and go in by one function.**
   The first is the hook: `sandbox.ts#hookSetupScript` is the bash a project's
   environment runs as its `setup_script`, writing `/home/sprite/.salon/changes.sh`
   and Claude Code's `~/.claude/settings.local.json` with `SessionStart`,
   `PostToolUse` (Edit|Write|MultiEdit|NotebookEdit|Bash) and `Stop` hooks.
   It is the *local* settings file on purpose: Fountain's claude runtime
   writes `~/.claude/settings.json` whole, after the setup script, and the
   runtime's cwd is `/home/sprite`, so the "project" file is that same path;
   claude-agent-acp loads `user`, `project` and `local`, and only local
   survives. The hook runs as a child of the runtime, so it holds
   `$FOUNTAIN_TOKEN` and `$FOUNTAIN_CONVERSATION_ID`; on `session` it moves a
   checkout still on the base onto `salon/<conv id[0:8]>`; every run POSTs
   branch, head, `git status --porcelain`, and `git diff <merge-base>` plus
   untracked files, to `PUBLIC_URL/hooks/changes` (curl, through the
   broker's proxy like everything else; the body goes through jq
   `--rawfile` because one shell argument caps at 128 KB). Tool runs are
   held to one post per two seconds. `changes.ts#record` is the one way a
   snapshot gets in — a sandbox exec API on Fountain would be its second
   caller, same table, same stream — it keeps the last twenty per chat,
   cuts a diff at 1 MB and says so. The hook is claude-only, like games.
   Verified end to end 2026-09-02 against `github.com/managoat/salon`.
   The second is Salon reading the computer itself, through Fountain's
   three read-only sandbox routes — `GET /api/sandboxes/:id/files`, `/file`,
   `/diff` (Fountain PR #1397, ADR 0039: full-scope key, a `ready` sandbox
   only, paths under the home, values of the environment redacted; **there
   is no exec route and there will not be one** — #1361 proposed it and
   was closed). `server/files.ts#refresh` (`POST …/changes/refresh`, any
   member; the ↻ on the panel, and every browser when a turn ends) finds
   the sandbox by the conversation's `sandbox_id`, and assembles the same
   snapshot the hook posts: `git diff <base>` (the local base as cloned,
   else `origin/<base>`, else HEAD), `git diff` and `git diff --cached` as
   the two columns of a `git status` (`shared/changes.ts#statusFromDiffs`),
   and the `.git` ref files for the branch, the head and the upstream —
   `ahead` is 0 when the remote ref matches, null when there is none, and
   `AHEAD_UNKNOWN` (−1) when it differs, since the routes cannot count.
   What it cannot see: untracked files (the panel says so), and the pull
   request, carried over from the branch's last snapshot. It works on every
   runtime, which is how a codex or gemini chat gets a panel at all. A
   turn-end refresh is skipped when a snapshot under eight seconds old is
   held (the hook's own Stop post), and refreshes in flight are shared per
   chat. `GET …/files?path=` and `GET …/file?path=` are the panel's Files
   view: paths are relative to the repository and kept inside it
   (`shared/files.ts#cleanPath`) before Fountain confines them again. Every
   refusal passes through with Fountain's code (`sandbox_not_ready` 409 —
   a parked computer is never woken for a read — `path_not_found`,
   `sandbox_unreachable`); a Fountain without the routes is a 501
   `files_unavailable`. Verified 2026-09-02 on managoat.com with a codex
   chat in a project (no hook there): the early refresh was refused
   `sandbox_not_ready` while the computer started; after the turn, the
   refresh showed the branch, the unpushed head and the one-line diff, and
   Files listed the checkout and read a file. The fake's shapes are the
   real ones.

7. **A project is the owner's environment, and its chats are the owner's.**
   The normal path starts in `server/github-access.ts`: a Fountain-signed-in
   user connects the GitHub App, the OAuth token is encrypted in
   `github_accounts`, and the picker is the intersection of repositories
   GitHub says both the person and the App installation can reach. On create,
   Salon mints an installation token narrowed to one repository with contents
   and pull-request access; the App private key and OAuth secret never leave
   the server. `server/projects.ts` turns that selection into one Environment on
   the *creator's* Fountain: `repositories: [{url, mount_path:
   /home/sprite/work/<repo>, ref: <base>, secret_key: GITHUB_TOKEN}]`,
   `packages.apt: [jq]`, and a `setup_script` that is the changes hook,
   the owner's git identity, `gh` best-effort, then the project's own
   command in the checkout. The short-lived token is written as `GITHUB_TOKEN`
   and `GH_TOKEN` (the clone reads one, `gh` the other), refreshed before each
   chat, and Salon keeps only the `github_repo` slug. The setup also installs a
   git credential helper that calls `/hooks/github-token` on the conversation's
   Fountain key for long-running sessions. Settings carry `projectId`;
   `chats.ts#create` swaps it for
   the project's `environmentId` *and for the project owner as host* — a
   member who starts a chat in a project starts it on the owner's key, and
   is a member of it, tagged from the first prompt. The project's people
   are copied into `chat_members` (`added_by = project:<id>`) on every
   chat in it, on create and when someone is added; removal takes back
   only what the project put in. The derived agent gets `on <project>` in
   its name (names are unique on Fountain) and `agents.ts#codeNote` in
   its prompt: where the repo is, branch off the base before the first
   change if the checkout is still on it (`salon/<conv id[0:8]>`, the same
   name the hook uses — the hook does it for claude at session start, the
   model does it everywhere else, since the setup script never sees the
   conversation id and is checkpointed for the next chat), commit as you
   go, `gh pr create` when asked, `Co-authored-by` for tagged senders. A
   derived agent whose prompt differs from today's is patched in place, so
   a change to the note reaches existing picks.
   Removing a project deletes the environment (Fountain retires its
   sandboxes; `409 sandbox_mid_turn` while one runs) and detaches the
   chats, which keep their transcripts.

8. **A comment is not a turn; sending them is one.** `server/comments.ts`
   keeps a comment per line (`path`, `side` new|old, `line` in the diff of
   the snapshot it was made on, the line's text as `quote`), anyone in the
   chat resolves one, its author or the host removes one, and every change
   is a `comment` event on the chat's stream. *Send N to the model* is
   `POST …/comments/send`: `shared/comments.ts#reviewPrompt` writes the
   open, unsent comments as one prompt grouped by file with each author
   named inside, the server sends it to Fountain on the host's key with
   the *sender's* tag (the proxy rule, applied here by hand), records the
   send, and marks the comments sent. Fountain's `conversation_busy` comes
   back with its code; nothing is marked sent then. Verified 2026-09-02:
   a comment on the added README line, sent, became a turn that rewrote
   the line and committed, and the next snapshot showed it.

9. **Ship: the checks are the snapshot, the asks are turns, archive keeps
   the chat.** The hook also reports `ahead` (commits past the upstream;
   null when there is no upstream) and the `gh pr view` record, and
   `shared/changes.ts#checks` turns status, `ahead` and `pr` into the
   strip on the panel — tree clean, branch pushed, pull request — with the
   open-comment count beside it. *Ask to push* and *Ask for a pull
   request* send a fixed prompt through the proxy: they are turns and say
   so, and they stay turns: Fountain will not run a command on a sandbox
   for an app (boundary 6), so pushing and merging are the model's to do.
   Archive (`POST …/archive`, host) terminates the
   conversation and sets `chats.archived_at`; changes and comments stay,
   and unpushed work goes with the computer, which the ⋯ menu says when
   the last snapshot shows it. Restore starts a *new* conversation on the
   same agent and environment with a prompt to fetch and check out the
   pushed branch, swaps `chats.conversation_id`, and clears `sends` (the
   new conversation's user turns count from one). The hook lives in the
   environment's setup script, so a project made before a hook change
   would keep the old one: `projects.ts#refreshEnvironment` puts the
   environment back the way Salon writes it today whenever a chat starts
   in the project and something differs (one GET, a PUT only then).
   Verified 2026-09-02: a chat start refreshed an older environment's
   hook; `ahead: null` arrived for a branch with no upstream; archive
   terminated the conversation; restore opened a new one whose hook
   posted under the new id, and the model said the unpushed branch was
   not on origin, which is what the archive warning is for.

## Run, test, ship

```bash
bun install
bun run server        # :8080, DATA_DIR=./data, FOUNTAIN_URL defaults to https://managoat.com
bun run dev           # Vite :5173, proxies /api and /f to :8080
bun run typecheck && bun test && bun run build
```

Tests run against a **fake Fountain** stood up with `Bun.serve` in
`server/app.test.ts`. Shape its responses like the real API — `{data: …}`
envelopes everywhere except `/api/auth/me` — and verify a new shape with one
real call before adding it to the fake.

**Smoke against the real Fountain, locally:** `PORT=8080 STATIC_DIR=dist
DATA_DIR=<scratch> bun server/index.ts`, then sign in with curl
(`POST /api/session {"apiKey": …}` using `[default]` from
`~/.fountain/credentials`; `[qs-hosted]` there is a second account, useful as
the guest). To use that session in a browser without pasting a key into the
page, set `document.cookie = 'salon_session=<token>; path=/'` and reload —
the server reads the cookie header either way. A real Opus turn provisions
and streams in about a minute; one with a skill attached also runs the
skills.sh install first. Retire the chat afterwards (⋯ → Retire) so the
computer is released. `[default]` is brokered (connections exist);
`[qs-hosted]` is not, so it is also the way to see the disabled Connectors
state — and it has no Anthropic credential, so a Claude turn there fails
`Authentication required`; host with `[default]`.

**Smoke the games tool, or the changes hook:** the computer must reach this
server, so run a tunnel (`cloudflared tunnel --url http://localhost:8090`
prints a trycloudflare URL; wait for "Registered tunnel connection") and
start the server with `PUBLIC_URL=<that url>`. Two things bit on 2026-09-02:
port 8080 is often held by the fountain-workbench server (its `/healthz`
answers `ok` too, and its sign-in sets `wb_session`), so use 8090; and a
server started with `&` from an agent's shell dies with that shell — run it
detached. For the hook: create an Environment on `[default]` with
`repositories: [{url, mount_path: "/home/sprite/work/<name>", ref: "main"}]`,
`packages: {apt: ["jq"]}` and `setup_script` from `hookSetupScript` — or
simply `POST /api/projects {"repoUrl": "github.com/managoat/salon"}` and
start a chat with `settings.projectId`, which is the same thing through
the seam (verified 2026-09-02: branch, commit, clean tree, diff against
main, all on the panel). A missed POST is not retried: press ↻ on the
panel, which reads the repository through Fountain instead. Without a
tunnel, ↻ is the only source, which is a fine smoke of `files.ts` on its
own (a codex chat in a project needs no tunnel at all). A
brokered sandbox reaches it only through `HTTPS_PROXY`, which the runtime
honours. Start a chat, add the guest, wait for the first turn to finish
(a prompt during a turn is `conversation_busy`), then send "let's play
tic-tac-toe, me against <guest>"; the transcript gets an
`mcp__salon__start_game` block and `GET /api/chats/:id/games` shows the
row. An MCP server that failed at session start is not retried — fix,
then start a *new* chat. To look inside the computer: `GET /api/sandboxes`
gives `sprite_name`, and `sprite exec -s <name> --file diag.sh:/tmp/d.sh
bash /tmp/d.sh` runs there; the runtime's MCP log is
`~/.cache/claude-cli-nodejs/-home-sprite/mcp-logs-salon/*.jsonl`. Retire
the chat afterwards; the derived agent keeps the tunnel URL until the next
chat on a server with the real `PUBLIC_URL` re-patches it.

**Ship:** push to `main`. `build.yml` tests, builds the SPA on the runner,
pushes `ghcr.io/managoat/salon` (multi-arch) and commits the sha pin into
`k8s/deployment.yaml` — so pull before your next push. Flux on home-cloud
(`chant/src/apps.ts`, `salonSource`/`salon`) applies `k8s/`; a stuck
`dependency … not ready` clears with `flux reconcile kustomization
flux-system`. The Fountain side is two settings on home-cloud's
`platform/fountain-site/patches/deployment.yaml`: the origin in
`API_CORS_ORIGINS` (the OAuth token exchange is a cross-origin fetch, so it
is needed despite the app having its own server) and the `salon` client in
`OAUTH_CLIENTS` with the exact redirect `https://salon.demo.managoat.com/`.
A change there rolls the Fountain pods — check nothing is provisioning first.

## Open follow-ups

- Salon is not on managoat.com/built-with or demo.managoat.com. Add it to
  `built_apps/0` (fountain, `marketing_html.ex`) **and** `src/roster.ts`
  (fountain-demos) in the same sitting, or the demos drift check goes red.
- `SALON_SECRET` is generated into the volume in prod; a `salon-secrets`
  Secret in the namespace would keep it apart from the data.
- No presence or typing indicators; guests learn of a new turn from the
  conversation stream and a 30 s chat-list poll. The game stream
  (`server/hub.ts`) is the channel Salon owns; presence could
  ride on it.
- Merge and push are prompts, and stay prompts: there will be no exec
  route (#1361 closed). If buttons are ever wanted, the way is a narrow
  git verb on Fountain's side (push this branch, open a PR), not a shell.
- Games are Anthropic-only: codex and gemini get no `salon` server. The
  model never plays; a `move` tool would make each of its moves a turn.
  Tic-tac-toe is the only game; `shared/games.ts` is where a second one's
  rules go, keyed by `kind`.
- Fountain sends the raw `mcp_servers` on the ACP session (boundary 5);
  fix there, then delete `sandbox.ts#unescaped`.
- A refresh cannot see untracked files or `gh pr view`; if Fountain's diff
  route ever grows an `untracked` flag, `files.ts#snapshot` is the one
  place to use it. No new Fountain API is planned for Salon: what the
  panel cannot read, the model is asked for.
- Commits from a codex chat were authored `AoD <aod@local>` although
  `~/.gitconfig` held the owner's identity from the setup script (read
  through the file route), so the runtime's environment must carry
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*`. Worth a look before attribution
  matters; not a Salon bug.
- Removing a project deletes its environment but not the agents derived
  on it (`Salon · … · on <project>`); they are harmless and findable by
  name, but a cleanup on project removal would be tidy.
- Fountain's claude runtime overwrites `~/.claude/settings.json` after the
  setup script; a merge there would let the hook live in the user file.
- Outlook, Slack and tenant `oauth2` connections show in Connectors as "not
  usable yet": the token is brokered as an env var, so using one means
  shipping an MCP server in the sandbox that reads it.
- The transcript shows the `acp` stream only; a turn's raw stdout is not
  fetched. If a failed turn ever needs it, add a "Show details" toggle in
  `Thread.tsx` rather than the old stdout checkbox.
