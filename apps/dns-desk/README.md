# DNS Desk

A dedicated DNS operator for your Cloudflare zones, as an app: ask for a
change in plain words, review the agent's plan as a diff, approve, done. The
zone tables stay on screen; the agent does the work.

It is a static single-page app with no backend of its own — it talks only to
the [Fountain](https://github.com/BinaryBourbon/fountain) API, where the desk
runs as a teammate (an agent in a sandbox with a Cloudflare token in a vault).
Client patterns (OAuth, SSE, API client) follow
[fountain-team](https://github.com/managoat/fountain-team).

## Run it

```bash
bun install
bun run dev        # http://localhost:5174
```

On first load, enter your Fountain URL and **Sign in with Fountain** (OAuth
code + PKCE; the token is an API key), or paste an API key. Then either pick a
teammate already running the `dns-desk` agent, or let the app hire one: it
creates the agent with the built-in operating rules and adds it to your team
with the vault you choose.

The vault must hold `CLOUDFLARE_API_TOKEN` (Zone → DNS → Edit). The desk
operates every zone the token can see, so the token's zone list — not the
prompt — is the real blast-radius control: scope it to exactly the zones the
desk should manage, whether that is one zone or all of them.

Server-side requirements, same as any external Fountain client:

```
API_CORS_ORIGINS=http://localhost:5174     # or wherever you host the build

# only for "Sign in with Fountain" — JSON, redirect URIs match exactly:
OAUTH_CLIENTS='[{"id":"dns-desk","name":"DNS Desk","redirect_uris":["http://localhost:5174/"]}]'
```

## How it works: the desk protocol

The agent may only *read* on its own. Every mutation goes through a plan the
owner approves — enforced today by convention (the system prompt pins it; the
audit trail shows it), and by Fountain's approval gates once those exist
(BinaryBourbon/fountain#643, which this app is a forcing function for).

The app and the agent share three fenced blocks, parsed out of the agent's
replies (`src/lib/protocol.ts`; the agent's side of the contract is
`src/lib/spec.ts` — change one, change both):

    ```dns-state
    {"fetched_at":"…","complete":false,"zones":[{"name":"example.com","id":"…","records":[…]}]}
    ```

State is incremental per zone: a block updates the zones it names and the app
merges it into what it already knows, so applying a one-zone change re-reads
one zone, not the fleet. `"complete": true` marks a full snapshot (an
explicit refresh) — zones absent from it are dropped.

    ```dns-plan
    {"id":"plan-x7k2","zone":"example.com","summary":"…","changes":[{"op":"create","type":"A","name":"demo.example.com","content":"203.0.113.7","ttl":1,"proxied":false}]}
    ```

    ```dns-result
    {"plan_id":"plan-x7k2","status":"applied","detail":"…"}
    ```

Approval is a plain message: `APPROVE plan-x7k2` (the Approve button sends
it). The desk re-reads the zone before applying and re-plans instead of
applying a stale diff. Plan status is always *derived* from the conversation —
a result block settles it, a decision message marks it, a newer plan
supersedes an older undecided one — never stored anywhere else. The
conversation is the system of record; **Zones** is a view of the newest
`dns-state`, **Activity** is the request/plan/decision feed.

## Development

```bash
bun test           # protocol, ACP block parsing, SSE parsing, render smoke
bun run typecheck
bun run build      # tsc + vite
```

To work on the UI without a live Fountain, run the mock
(`bun run mock`), start the app through the dev proxy
(`FOUNTAIN_PROXY=http://localhost:8787 bun run dev`), and open
`http://localhost:5174/dev-seed.html` once to point the app at it — you land
on a desk with a zone and a plan awaiting approval.

No state outside the browser: settings in `localStorage`
(`dns-desk.settings`), the chosen teammate per Fountain URL
(`dns-desk.desk`).

## License

MIT
