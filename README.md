# Arena

One prompt, several brains, side by side. Pick two to four models from the
catalog, hit **Fight**, and watch the answers stream into equal columns —
blind by default, labels A/B/C until you vote. Same sandbox platform, live
streams, your vote decides.

It is a static single-page app with no backend of its own — it talks only to
the [Fountain](https://github.com/BinaryBourbon/fountain) API, where each
contender runs as a teammate (one agent per model, hired lazily on the first
fight and reused across rounds). Client patterns (OAuth, SSE, API client)
follow [dns-desk](https://github.com/jhgaylor/dns-desk).

## Run it

```bash
bun install
bun run dev        # http://localhost:5175
```

On first load, enter your Fountain URL and **Sign in with Fountain** (OAuth
code + PKCE; the token is an API key), or paste an API key. Pick your brains,
type one prompt, Fight. Each contender answers in its own conversation, so a
follow-up prompt goes to all of them with their own context — multi-turn
face-offs work out of the box. Click the winning column to vote: names are
revealed, the win lands on the scoreboard, and the round joins the history
rail.

Contenders, rounds and votes are remembered per Fountain URL in this browser
(`localStorage`); the conversations themselves live in Fountain and are the
system of record — clicking an old round reloads its turns from the API.

Server-side requirements, same as any external Fountain client:

```
API_CORS_ORIGINS=http://localhost:5175     # or wherever you host the build

# only for "Sign in with Fountain" — JSON, redirect URIs match exactly:
OAUTH_CLIENTS='[{"id":"arena","name":"Arena","redirect_uris":["http://localhost:5175/"]}]'
```

(The production deployment at `arena.inevitable.fyi` needs the same two
entries with `https://arena.inevitable.fyi` / `https://arena.inevitable.fyi/`.)

## How it works

No protocol blocks — the reply text is the product. Each selected model gets
an agent named `Arena <model>` with a pinned system prompt (`src/lib/spec.ts`:
you are a contender; answer directly and well; no preamble), added to the team
via `POST /api/team`. A round sends the same prompt to every contender's
conversation (`POST /api/team/:agent_id/messages`) and follows all of them on
one `GET /api/team/stream` SSE connection, reconnecting with `Last-Event-ID`.

Per column, everything is derived from turns + events: status, time to first
output chunk (first output event vs. the turn's `started_at`, both server
timestamps), total duration, and the turn's token usage when the API reports
it. ACP events render like a chat preview — text, collapsed thinking, tool
chips (`src/lib/acp.ts`). A contender erroring or timing out shows an error
state in its column while the others keep streaming; **Interrupt all** stops a
round mid-flight. Fountain has no server-side message queue, so the app waits
out `conversation_busy` / `provisioning` client-side and disables Fight until
all columns settle.

If the catalog has only one model, the picker offers it twice (`#1` / `#2`) —
two teammates on the same model is still a fight.

## Development

```bash
bun test           # picker/round/scoreboard/metrics derivation, ACP + SSE parsing, render smoke
bun run typecheck
bun run build      # tsc + vite
```

To work on the UI without a live Fountain, run the mock (`bun run mock`),
start the app through the dev proxy
(`FOUNTAIN_PROXY=http://localhost:8787 bun run dev`), open
`http://localhost:5175`, and paste any string as the API key with
`http://localhost:5175` as the URL — hiring, streaming columns, votes and the
scoreboard all work against canned brains.

No state outside the browser: settings in `localStorage` (`arena.settings`),
hired contenders per Fountain URL (`arena.contenders`), rounds and votes
(`arena.rounds`).

## License

MIT
