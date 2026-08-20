# Watchtower

An SRE teammate on a schedule: uptime, latency, TLS expiry and DNS for every
site you name — and when something's red, you ask it to go dig. The dashboard
is tiles and sparklines; the agent does the probing, with real tools
(`curl`, `openssl s_client`, `dig`, `traceroute`) from its own sandbox.

It is a static single-page app with no backend of its own — it talks only to
the [Fountain](https://github.com/BinaryBourbon/fountain) API, where Watchtower
runs as a teammate. The heartbeat is a Fountain **team schedule**: a cron that
prompts the agent to patrol, every 30 minutes by default. Client patterns
(OAuth, SSE, API client) follow [dns-desk](https://github.com/jhgaylor/dns-desk).

## Run it

```bash
bun install
bun run dev        # http://localhost:5175
```

On first load, enter your Fountain URL and **Sign in with Fountain** (OAuth
code + PKCE; the token is an API key), or paste an API key. Then either pick a
teammate already running the `watchtower` agent, or let the app hire one: it
creates the agent with the built-in patrol rules and adds it to your team. No
credentials or vaults are needed — the agent probes public endpoints from its
sandbox.

Then answer "What should I watch?" with URLs or hostnames. The app sends the
watchlist, creates the patrol schedule, and the tiles fill in as reports land.

Server-side requirements, same as any external Fountain client:

```
API_CORS_ORIGINS=http://localhost:5175     # or wherever you host the build

# only for "Sign in with Fountain" — JSON, redirect URIs match exactly:
OAUTH_CLIENTS='[{"id":"watchtower","name":"Watchtower","redirect_uris":["http://localhost:5175/"]}]'
```

The hosted build at `watchtower.inevitable.fyi` expects those two entries with
`https://watchtower.inevitable.fyi` / `https://watchtower.inevitable.fyi/`.

## How it works: the watch protocol

**The conversation is the system of record — and the metrics database.** The
app derives everything on screen from the agent's replies: the history of
`watch-state` blocks *is* the latency sparkline and the up/down strip. Nothing
is stored anywhere else (localStorage holds only settings and the chosen
teammate).

The app and the agent share three fenced blocks, parsed out of the agent's
replies (`src/lib/protocol.ts`; the agent's side of the contract is
`src/lib/spec.ts` — change one, change both):

    ```watch-config
    {"sites":["https://example.com","api.example.net"]}
    ```

The watchlist. The owner sets it with a plain message
(`SET WATCHLIST\n["https://a.com", ...]` — adding or removing a site re-sends
the whole list); the agent confirms by echoing it in a watch-config block, and
the app treats the newest confirmation as truth.

    ```watch-state
    {"checked_at":"…","sites":[{"url":"https://example.com","up":true,"status":200,"latency_ms":184,"cert_days_left":42,"cert_expires_at":"…","dns":["203.0.113.7"],"note":null}]}
    ```

One block per patrol, every watched site inside it — including sites that are
down or never resolve (`up: false` plus a human `note`). A tile goes red when
its site is down, amber when the certificate has under 14 days left.

    ```watch-incident
    {"url":"…","summary":"…","suspected_cause":"…","evidence":["…"],"checked_at":"…"}
    ```

The answer to an `Investigate <url>` message: the agent digs with headers,
traceroute, whois and repeated requests, and the app renders the block as an
incident card. While it digs, the tool calls stream live into the sidebar.

**The schedule is the product.** On setup the app creates a team schedule
(`POST /api/team/:agent_id/schedules`, `one_off: false`) with the prompt
"Run checks and report watch-state." — the schedule panel drives cadence
(5m/30m/hourly/daily), pause/resume and **Run now** through the schedules API,
and refreshes on the team stream's `schedule` event. Fountain has no
server-side message queue: while a patrol is running, sends get
400 `conversation_busy`, so the app queues client-side and flushes when the
turn's terminal stage event arrives.

## Development

```bash
bun test           # protocol, schedule/cadence, ACP block parsing, SSE parsing, render smoke
bun run typecheck
bun run build      # tsc + vite
```

To work on the UI without a live Fountain, run the mock
(`bun run mock`), start the app through the dev proxy
(`FOUNTAIN_PROXY=http://localhost:8788 bun run dev`), and open
`http://localhost:5175/dev-seed.html` once to point the app at it — you land
on a wall with four sites (one healthy, one with a dying cert, one flapping,
one that never resolves) and an incident already filed.

No state outside the browser: settings in `localStorage`
(`watchtower.settings`), the chosen teammate per Fountain URL
(`watchtower.tower`).

## License

MIT
