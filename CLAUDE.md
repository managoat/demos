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
          chats.ts     chats, members, invites, join
          proxy.ts     /f/<chat>/api/conversations/<id>/… on the host's key
          db.ts        SQLite: users, sessions, chats, chat_members, sends
shared/   what both sides agree on: author.ts, models.ts, settings.ts, skills.ts, images.ts
src/      Vite + React. store.tsx (session), router.ts (hash routes),
          components/Thread.tsx (transcript + composer), SettingsMenu.tsx (pill + `+`)
k8s/      Deployment/PVC/Service/IngressRoutes/Certificate; Flux (home-cloud) applies it
```

## Four boundaries, easy to get wrong

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
state.

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
  conversation stream and a 30 s chat-list poll.
- Outlook, Slack and tenant `oauth2` connections show in Connectors as "not
  usable yet": the token is brokered as an env var, so using one means
  shipping an MCP server in the sandbox that reads it.
- The transcript shows the `acp` stream only; a turn's raw stdout is not
  fetched. If a failed turn ever needs it, add a "Show details" toggle in
  `Thread.tsx` rather than the old stdout checkbox.
