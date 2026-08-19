# DNS Desk

A dedicated DNS operator for your Cloudflare zones, as an app: ask for a
change in plain words, review the agent's plan as a diff, approve, done. The
zone tables stay on screen; the agent does the work.

It is a static single-page app with no backend of its own — it talks only to
the [Fountain](https://github.com/BinaryBourbon/fountain) API, where the desk
runs as a teammate (an agent in a sandbox with a Cloudflare token in a vault).
Client patterns (OAuth, SSE, API client) follow
[fountain-team](https://github.com/jhgaylor/fountain-team).

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

The vault must hold `CLOUDFLARE_API_TOKEN` — make it a token scoped to just
the zones the desk should manage (Zone → DNS → Edit). That scoping, not the
prompt, is the real blast-radius control.

Server-side requirements, same as any external Fountain client:

```
API_CORS_ORIGINS=http://localhost:5174     # or wherever you host the build
OAUTH_CLIENTS=dns-desk|http://localhost:5174   # only for "Sign in with Fountain"
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
    {"fetched_at":"…","zones":[{"name":"example.com","id":"…","records":[…]}]}
    ```

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
bun test           # protocol, ACP block parsing, SSE parsing
bun run typecheck
bun run build      # tsc + vite
```

No state outside the browser: settings in `localStorage`
(`dns-desk.settings`), the chosen teammate per Fountain URL
(`dns-desk.desk`).

## License

MIT
