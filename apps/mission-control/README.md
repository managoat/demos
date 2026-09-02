# Mission Control

One goal, a fleet of agents: describe a mission in plain words, a coordinator
decomposes it into tasks, you approve the plan, and the app launches **one
sandboxed agent per task** — watch the fleet boot and work on a live board,
get one synthesized report at the end.

It is a static single-page app with no backend of its own — it talks only to
the [Fountain](https://github.com/BinaryBourbon/fountain) API. The coordinator
runs as a teammate; every worker is a plain `POST /api/conversations`, one
fresh computer each; the whole fleet streams back on a single
`GET /api/events/stream?blocks=true` connection. Client patterns (OAuth, SSE,
API client) follow [dns-desk](https://github.com/managoat/dns-desk).

## Run it

```bash
bun install
bun run dev        # http://localhost:5179
```

On first load, enter your Fountain URL and **Sign in with Fountain** (OAuth
code + PKCE; the token is an API key), or paste an API key. Then either pick a
`Mission Control` teammate already on your team, or let the app assemble the
crew: it creates the coordinator (plans and synthesizes, never executes) and a
`Mission Worker` agent (launched once per task) with the built-in operating
rules, and adds the coordinator to your team.

Server-side requirements, same as any external Fountain client:

```
API_CORS_ORIGINS=http://localhost:5179     # or wherever you host the build

# only for "Sign in with Fountain" — JSON, redirect URIs match exactly:
OAUTH_CLIENTS='[{"id":"mission-control","name":"Mission Control","redirect_uris":["http://localhost:5179/"]}]'
```

## How it works: the mission protocol

The app and the agents share three fenced blocks, parsed out of replies
(`src/lib/protocol.ts`; the agents' side of the contract is `src/lib/spec.ts`
— change one, change both):

    ```mission-plan
    {"id":"msn-4f2a","objective":"…","tasks":[{"id":"t1","title":"…","brief":"self-contained instruction for a worker with a fresh computer","deliverable":"what to return"}]}
    ```

The plan renders as task cards with **Approve & launch** / **Revise** (revise
is a plain reply; a newer plan supersedes). Plans are capped at 5 tasks in the
system prompt *and* clamped client-side. Approval sends `APPROVE msn-4f2a` to
the coordinator, then **the app does the fan-out**: one worker conversation
per task, prompt = objective + brief + task id. After launching it posts

    LAUNCHED msn-4f2a t1=<conversation-id> t2=<conversation-id> …

to the coordinator (which just acknowledges). That line makes the mission
recoverable from the conversation alone — the coordinator thread is the
system of record; localStorage only remembers the crew and the last mission.

Each worker ends its reply with

    ```task-result
    {"task_id":"t1","status":"done|blocked","summary":"…","output":"full deliverable, markdown"}
    ```

When every task has a result, the app sends the coordinator `RESULTS msn-4f2a`
plus the JSON, and the coordinator answers with

    ```mission-report
    {"id":"msn-4f2a","objective":"…","outcome":"…","sections":[{"heading":"…","body_md":"…"}]}
    ```

rendered as the final document with a per-task appendix and a **Download .md**
button (assembled client-side).

Edge cases the board handles: a worker failing or being interrupted goes red
with its failure stage and the mission can still synthesize once at least one
result exists (**Synthesize anyway**); `409 sandbox_quota_exceeded` on fan-out
launches what fits, says so plainly, and runs the rest as computers free up;
`400 conversation_busy` on the coordinator queues the message client-side and
retries on the turn's terminal event — Fountain has no server-side queue.

## Development

```bash
bun test           # protocol, block folding, markdown, SSE parsing, render smoke
bun run typecheck
bun run build      # tsc + vite
```

To work on the UI without a live Fountain, run the mock (`bun run mock`),
start the app through the dev proxy
(`FOUNTAIN_PROXY=http://localhost:8791 bun run dev`), and open
`http://localhost:5179/dev-seed.html` once — you land on a console with a
mission in flight and a plan awaiting approval.

No state outside the browser: settings in `localStorage`
(`mission-control.settings`), the crew + last mission per Fountain URL
(`mission-control.crew`).

## License

MIT
